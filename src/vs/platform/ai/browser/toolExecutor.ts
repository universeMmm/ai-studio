/*---------------------------------------------------------------------------------------------
 *  AI Studio - Tool Executor
 *  Runtime implementation of the 8 built-in tools. All subprocess calls are
 *  async (spawn-based) to avoid blocking the Electron render thread.
 *  run_command includes a safe-command whitelist to prevent automatic
 *  execution of potentially destructive shell commands.
 *
 *  NOTE: This code runs in Electron's sandboxed renderer process where
 *  Node.js built-in modules (child_process, path, fs) are NOT available.
 *  We use inline polyfills for path operations and IPC for subprocess execution.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../../base/common/uri.js";
import { VSBuffer } from "../../../base/common/buffer.js";
import { IFileService } from "../../../platform/files/common/files.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import { MarkerSeverity, IMarkerService } from "../../../platform/markers/common/markers.js";
import { IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { BuiltInToolName } from "../common/aiTypes.js";
import { IAIIndexService } from "./aiIndexService.js";
import { IDiffStore } from "../../../workbench/contrib/aiDiffApply/browser/diffStore.js";
import type { DiffGroup, DiffHunk } from "../../../workbench/contrib/aiDiffApply/common/diffTypes.js";

// --- Inline path polyfill ---------------------------------------------------
// Electron sandboxed renderer cannot access Node.js "path" module.
// Pure-string implementations of the subset we need.

const _sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
const _isWin = _sep === '\\';

function _normalizePath(p: string): string {
	if (!p) return '.';
	let isAbs = false;
	let prefix = '';
	if (_isWin) {
		const m = p.match(/^([a-zA-Z]:)([\\/]?)/);
		if (m) { prefix = m[1]; p = p.slice(m[0].length); isAbs = true; }
	} else if (p.startsWith('/')) {
		isAbs = true;
	}
	const parts = p.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.');
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '..') { resolved.pop(); continue; }
		resolved.push(part);
	}
	let result = resolved.join('/');
	if (_isWin) {
		result = prefix + (result ? '\\' + result.replace(/\//g, '\\') : '\\');
	} else if (isAbs) {
		result = '/' + result;
	}
	return result || (isAbs ? (_isWin ? prefix + '\\' : '/') : '.');
}

function _resolvePath(...segments: string[]): string {
	let result = '';
	for (let i = segments.length - 1; i >= 0; i--) {
		if (!segments[i]) continue;
		result = result ? _join(segments[i], result) : segments[i];
		if (_isAbsolute(result)) break;
	}
	return _normalizePath(result);
}

function _join(...segments: string[]): string {
	return _normalizePath(segments.filter(Boolean).join('/'));
}

function _isAbsolute(p: string): boolean {
	if (_isWin) return /^[a-zA-Z]:[\\/]/.test(p);
	return p.startsWith('/');
}

function _relative(from: string, to: string): string {
	const a = _normalizePath(_resolvePath(from)).replace(/\\/g, '/').split('/').filter(Boolean);
	const b = _normalizePath(_resolvePath(to)).replace(/\\/g, '/').split('/').filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const ups = Array(a.length - i).fill('..');
	return [...ups, ...b.slice(i)].join('/');
}


// Safe command patterns — auto-approved when ai.commandApproval is "unsafe"
const SAFE_COMMAND_PATTERNS = [
    /^\s*(dir|ls|pwd)(\s|$)/i,
    /^\s*(cat|type)(\s|$)/i,
    /^\s*(echo|print)(\s|$)/i,
    /^\s*get-content\s/i,
    /^\s*git\s+(status|log|diff|branch|show|stash\s+list|remote\s+-v|rev-parse|config\s+--list|ls-files|describe|tag\s+-l|shortlog)\b/i,
    /^\s*npm\s+(list|ls|view|outdated|audit|config\s+list)\b/i,
    /^\s*(where|which|whereis|type)\s/i,
    /^\s*(node|python|python3)\s+--version\b/i,
    /^\s*(rg|grep|findstr)\s/i,
    /^\s*wc\s/i,
    /^\s*head\s/i,
    /^\s*tail\s/i,
    /^\s*sort\s/i,
    /^\s*uniq\s/i,
    /^\s*du\s/i,
    /^\s*diff\s/i,
];

function isCommandSafe(command: string): boolean {
	return SAFE_COMMAND_PATTERNS.some(p => p.test(command));
}

const SENSITIVE_FILE_PATTERNS = [
	/\.env(\..*)?$/,
	/\.pem$/,
	/\.key$/,
	/credentials/i,
	/secret/i,
	/\.npmrc$/,
	/id_rsa/,
	/\.pfx$/,
	/\.p12$/,
];

const BINARY_EXTENSIONS = new Set([
	'.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.zip',
	'.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.png', '.jpg',
	'.jpeg', '.gif', '.bmp', '.ico', '.mp3', '.mp4', '.avi',
	'.mov', '.wmv', '.flv', '.pdf', '.doc', '.docx', '.xls',
	'.xlsx', '.ppt', '.pptx', '.wasm', '.o', '.obj', '.class',
	'.pyc', '.pyo', '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

function isSensitiveFile(filePath: string): boolean {
	return SENSITIVE_FILE_PATTERNS.some(p => p.test(filePath));
}

function isBinaryFile(filePath: string): boolean {
	const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

const DANGEROUS_SHELL_PATTERNS = [
	/\$\{/,
	/\$\(/,
	/`[^`]+`/,
	/\|.*\b(?:sh|bash|zsh|cmd|powershell)\b/i,
	/&&.*\b(?:rm|dd|mkfs|format|shutdown)\b/i,
	/;\s*(?:rm|dd|mkfs|shutdown)\b/i,
];

function hasShellInjection(command: string): boolean {
	return DANGEROUS_SHELL_PATTERNS.some(p => p.test(command));
}

/**
 * Simple shell-argument parser. Splits on whitespace while respecting
 * single- and double-quoted strings.
 *
 * @returns Array of arguments, or null if input contains unsafe shell
 *          metacharacters (;, |, &, <, >, backtick, $).
 */
function parseSimpleArgs(input: string): string[] | null {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (current) { args.push(current); current = ""; }
			continue;
		}
		if (/[;&|<>`$]/.test(ch)) return null;
		current += ch;
	}
	if (quote) return null;
	if (current) args.push(current);
	return args;
}

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

/**
 * Runtime execution engine for the 8 built-in AI tools.
 *
 * Each tool method receives plain input values parsed from the AI's JSON
 * tool-call and returns a human-readable result string.
 *
 * **Security model for run_command:**
 * 1. Shell-injection check blocks commands with $(...), backticks, |sh, etc.
 * 2. Safe-command whitelist — when ai.commandApproval is "unsafe" (default),
 *    only commands matching SAFE_COMMAND_PATTERNS auto-approve.
 * 3. Full-auto mode — set ai.commandApproval to "none" to skip approval.
 *
 * **subprocess execution** delegates to the VS Code main process via
 * `vscode.ipcRenderer.invoke`. In the sandboxed renderer there is no
 * direct access to child_process.
 */
export class ToolExecutor {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IAIIndexService private readonly indexService: IAIIndexService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	/**
	 * Entry point for tool dispatch. Routes `toolName` to the matching
	 * private method and returns the tool's string result.
	 */
	async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
		try {
			switch (toolName) {
				case BuiltInToolName.ReadFile:        return await this._readFile(input);
				case BuiltInToolName.WriteFile:       return await this._writeFile(input);
				case BuiltInToolName.EditFile:        return await this._editFile(input);
				case BuiltInToolName.SearchContent:   return await this._searchContent(input);
				case BuiltInToolName.SearchFiles:     return await this._searchFiles(input);
				case BuiltInToolName.RunCommand:      return await this._runCommand(input);
				case BuiltInToolName.ListDirectory:   return await this._listDirectory(input);
				case BuiltInToolName.ReadLints:       return await this._readLints(input);
				case BuiltInToolName.SearchPattern:  return await this._searchPattern(input);
				default:                              return "Error: unknown tool \"" + toolName + "\"";
			}
		} catch (err) {
			this.logService.error("[ToolExecutor] " + toolName + ":", err);
			return "Error executing " + toolName + ": " + (err instanceof Error ? err.message : String(err));
		}
	}

	// -- Snapshot / Rollback --------------------------------------------------

	private _snapshots: Map<string, VSBuffer> = new Map();

	async createSnapshot(files: string[]): Promise<void> {
		this._snapshots.clear();
		for (const fp of files) {
			try {
				const uri = URI.file(this._resolvePath(fp));
				const content = await this.fileService.readFile(uri);
				this._snapshots.set(fp, content.value);
			} catch { /* may not exist */ }
		}
	}

	async rollbackAll(): Promise<string> {
		if (!this._snapshots.size) return "Nothing to rollback.";
		let r = 0;
		for (const [fp, content] of this._snapshots) {
			try { await this.fileService.writeFile(URI.file(this._resolvePath(fp)), content); r++; }
			catch (e) { this.logService.error("[ToolExecutor] rollback " + fp + ":", e); }
		}
		this._snapshots.clear();
		return "Rolled back " + r + " file(s).";
	}

	commitSnapshot(): void { this._snapshots.clear(); }

	// -- Path helpers ---------------------------------------------------------

	/**
	 * Resolves a workspace-relative (or absolute) path to an absolute path,
	 * validating that it stays inside the workspace root.
	 *
	 * @throws If no workspace is open, or if the path escapes the workspace.
	 */
	private _resolvePath(filePath: string): string {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!root) { throw new Error("No workspace folder is open."); }
		const resolved = _resolvePath(root, filePath);
		const rel = _relative(root, resolved);
		if (rel.startsWith("..") || _isAbsolute(rel)) {
			throw new Error("Path is outside the workspace: " + filePath);
		}
		return resolved;
	}

	private _getCwd(): string {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath || ".";
	}

	// -- Tool implementations -------------------------------------------------

	private async _readFile(input: Record<string, unknown>): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		if (isBinaryFile(fp)) { return "Error: cannot read binary file: " + (input.path as string); }
		if (isSensitiveFile(fp)) { return "Error: cannot read sensitive file: " + (input.path as string); }
		const offset = (input.offset as number) || 0;
		const limit = (input.limit as number) || undefined;
		const content = await this.fileService.readFile(URI.file(fp));
		const lines = content.value.toString().split("\n");
		const start = offset > 0 ? offset - 1 : 0;
		const end = limit ? start + limit : lines.length;
		return lines.slice(start, end).map((line: string, i: number) => String(start + i + 1).padStart(4, " ") + "| " + line).join("\n");
	}

	private async _writeFile(input: Record<string, unknown>): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		if (isSensitiveFile(fp)) { return "Error: cannot write to sensitive file: " + (input.path as string); }
		const content = input.content as string;
		let originalContent = "";
		try { originalContent = (await this.fileService.readFile(URI.file(fp))).value.toString(); } catch { /* new file */ }
		await this.fileService.writeFile(URI.file(fp), VSBuffer.fromString(content));

		const origLines = originalContent.split("\n");
		const newLines = content.split("\n");
		const hunk: DiffHunk = {
			id: "hunk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
			filePath: input.path as string,
			originalStartLine: 1, originalEndLine: origLines.length || 1,
			modifiedStartLine: 1, modifiedEndLine: newLines.length || 1,
			originalText: originalContent, modifiedText: content, status: "applied",
		};
		const group: DiffGroup = {
			id: "group_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
			chatMessageId: "", hunks: [hunk], createdAt: Date.now(),
		};
		this.diffStore.addGroup(group);
		return "File written: " + (input.path as string);
	}

	private async _editFile(input: Record<string, unknown>): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		const oldStr = input.old_string as string;
		const newStr = input.new_string as string;
		const replaceAll = !!(input.replace_all as boolean);

		if (!oldStr) { return "Error: old_string must not be empty"; }

		const uri = URI.file(fp);
		const content = (await this.fileService.readFile(uri)).value.toString();
		if (!replaceAll && content.indexOf(oldStr) === -1) { return "Error: old_string not found in " + (input.path as string); }

		let origStart = 0, origEnd = 0;
		const idx = content.indexOf(oldStr);
		if (idx >= 0) {
			const before = content.slice(0, idx);
			origStart = before.split("\n").length;
			origEnd = origStart + oldStr.split("\n").length - 1;
		}
		const newContent = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
		await this.fileService.writeFile(uri, VSBuffer.fromString(newContent));

		const newLines = newStr.split("\n");
		const hunk: DiffHunk = {
			id: "hunk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
			filePath: input.path as string,
			originalStartLine: origStart, originalEndLine: origEnd,
			modifiedStartLine: origStart, modifiedEndLine: origStart + newLines.length - 1,
			originalText: oldStr, modifiedText: newStr, status: "applied",
		};
		const group: DiffGroup = {
			id: "group_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
			chatMessageId: "", hunks: [hunk], createdAt: Date.now(),
		};
		this.diffStore.addGroup(group);
		return "File edited: " + (input.path as string);
	}

	private async _searchContent(input: Record<string, unknown>): Promise<string> {
		const pattern = input.pattern as string;
		try {
			const results = await this.indexService.search(pattern, 10);
			if (!results.length) { return "No results for \"" + pattern + "\"."; }
			return results.map(r => r.filePath + ":" + r.startLine + "\n" + r.content).join("\n---\n");
		} catch (err) { return "Search error: " + (err instanceof Error ? err.message : String(err)); }
	}

	private async _searchPattern(input: Record<string, unknown>): Promise<string> {
		const rawArgs = input.rg_args as string;
		const args = parseSimpleArgs(rawArgs);
		if (!args) {
			return "Error: ripgrep arguments contain unsupported shell syntax.";
		}
		if (args.some(arg => arg === "--replace" || arg === "--files-without-match" || arg === "--type-list" || arg === "-r" || arg.startsWith("--replace="))) {
			return "Error: ripgrep flags --replace, -r (replace mode), --files-without-match, and --type-list are not allowed.";
		}
		const cwd = this._getCwd();
		try {
			const result = await this._spawn("rg", args, cwd, 15_000, 5 * 1024 * 1024);
			if (result.exitCode !== 0 && !result.stdout) {
				return result.stderr || "No matches found.";
			}
			const lines = result.stdout.trim().split('\n').slice(0, 100);
			return lines.join('\n') || "No matches found.";
		} catch (e) {
			return "Search error: " + (e instanceof Error ? e.message : String(e));
		}
	}

	private async _searchFiles(input: Record<string, unknown>): Promise<string> {
		const pattern = input.pattern as string;
		const cwd = this._getCwd();
		// Try ripgrep first
		try {
			const result = await this._spawn("rg", ["--files", "--glob", pattern], cwd, 10_000, 5 * 1024 * 1024);
			if (result.exitCode === 0 && result.stdout.trim()) {
				const files = result.stdout.trim().split("\n").filter(Boolean);
				return files.length ? files.slice(0, 50).join("\n") : "No files matching \"" + pattern + "\".";
			}
		} catch { /* rg unavailable, fall through */ }
		// Fallback: walk filesystem via IFileService
		try {
			const results: string[] = [];
			const excludeDirs = new Set([".git", "node_modules", ".ai-studio", "out", "dist", ".build"]);
			const globToRegex = (g: string): RegExp => {
				const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
				return new RegExp('^' + escaped + '$', 'i');
			};
			const regex = globToRegex(pattern);
			const walked = new Set<string>();
			async function walk(dir: string, fileService: IFileService) {
				if (walked.has(dir)) return;
				walked.add(dir);
				try {
					const stat = await fileService.resolve(URI.file(dir));
					if (!stat.children) return;
					for (const c of stat.children) {
						const full = _join(dir, c.name);
						if (c.isDirectory) { if (!excludeDirs.has(c.name)) await walk(full, fileService); }
						else if (regex.test(c.name)) results.push(full);
					}
				} catch { /* permission denied */ }
			}
			await walk(cwd, this.fileService);
			return results.length ? results.slice(0, 50).join("\n") : "No files matching \"" + pattern + "\".";
		} catch {
			return "No files matching \"" + pattern + "\".";
		}
	}

	private async _runCommand(input: Record<string, unknown>): Promise<string> {
		const cmd = input.command as string;
		if (hasShellInjection(cmd)) {
			return "[BLOCKED] Command contains potentially unsafe shell constructs: " + cmd.slice(0, 80);
		}
		const timeout = (input.timeout as number) || 120_000;
		const cwd = this._getCwd();

		// Check approval policy
		const approval = this.configurationService.getValue<string>("ai.commandApproval") || "unsafe";
		if (approval === "all") {
			return "[REQUIRES_APPROVAL] Command: " + cmd + "\nSet ai.commandApproval to \"unsafe\" or \"none\" to auto-execute.";
		}
		if (approval === "unsafe" && !isCommandSafe(cmd)) {
			return "[REQUIRES_APPROVAL] Unsafe command: " + cmd + "\nThis command does not match known safe patterns. Set ai.commandApproval to \"none\" to auto-execute all commands.";
		}

		try {
			const result = await this._execShell(cmd, cwd, timeout, 10 * 1024 * 1024);
			if (result.exitCode === 0) {
				return result.stdout || "(no output)";
			}
			return "Command failed (exit " + result.exitCode + "): " + (result.stderr || result.stdout || "unknown error");
		} catch (err) {
			return "Command error: " + (err instanceof Error ? err.message : String(err));
		}
	}

	private async _listDirectory(input: Record<string, unknown>): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		const stat = await this.fileService.resolve(URI.file(fp));
		if (!stat.children) { return "(empty) " + (input.path as string); }
		return stat.children.map((c: any) => (c.isDirectory ? "[DIR] " : "[FILE] ") + c.name).join("\n");
	}

	private async _readLints(input: Record<string, unknown>): Promise<string> {
		const fp = input.path as string | undefined;
		if (fp) {
			const markers = this.markerService.read({ resource: URI.file(this._resolvePath(fp)) });
			if (!markers.length) { return "No issues for " + fp; }
			return markers.map((m: any) => {
				const s = m.severity === MarkerSeverity.Error ? "ERROR" : m.severity === MarkerSeverity.Warning ? "WARN" : "INFO";
				return "[" + s + "] " + fp + ":" + m.startLineNumber + ":" + m.startColumn + " " + m.message;
			}).join("\n");
		}
		const all = this.markerService.read({ take: 50 });
		return all.length ? all.map((m: any) => {
			const s = m.severity === MarkerSeverity.Error ? "ERROR" : m.severity === MarkerSeverity.Warning ? "WARN" : "INFO";
			return "[" + s + "] " + m.resource.fsPath + ":" + m.startLineNumber + " " + m.message;
		}).join("\n") : "No issues workspace-wide.";
	}

	// -- Subprocess execution (IPC via vscode sandbox globals) -----------------

	/**
	 * Spawn a child process via the main-process IPC bridge.
	 * Falls back to an informative error message when IPC is unavailable.
	 */
	private async _spawn(
		command: string,
		args: string[],
		cwd: string,
		timeoutMs: number,
		maxBuffer: number,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const vscodeWin = (globalThis as any).vscode;
			if (vscodeWin?.ipcRenderer?.invoke) {
				const result = await vscodeWin.ipcRenderer.invoke(
					'vscode:ai-studio:exec',
					{ command, args, cwd, timeout: timeoutMs }
				);
				if (result && typeof result === 'object') {
					return {
						stdout: String(result.stdout || '').slice(0, maxBuffer),
						stderr: String(result.stderr || '').slice(0, maxBuffer),
						exitCode: result.exitCode ?? result.code ?? 0,
					};
				}
			}
		} catch { /* IPC unavailable, return fallback below */ }

		return {
			stdout: '',
			stderr: `Cannot spawn "${command}" — subprocess execution requires the AI Studio main-process handler to be registered.`,
			exitCode: -1,
		};
	}

	/**
	 * Execute a shell command string via the main-process IPC bridge.
	 */
	private async _execShell(
		cmd: string,
		cwd: string,
		timeoutMs: number,
		maxBuffer: number,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const vscodeWin = (globalThis as any).vscode;
			if (vscodeWin?.ipcRenderer?.invoke) {
				const result = await vscodeWin.ipcRenderer.invoke(
					'vscode:ai-studio:exec',
					{ shell: true, command: cmd, cwd, timeout: timeoutMs }
				);
				if (result && typeof result === 'object') {
					return {
						stdout: String(result.stdout || '').slice(0, maxBuffer),
						stderr: String(result.stderr || '').slice(0, maxBuffer),
						exitCode: result.exitCode ?? result.code ?? 0,
					};
				}
			}
		} catch { /* fallback below */ }

		return {
			stdout: '',
			stderr: `Cannot execute shell command — the AI Studio IPC exec handler is not registered in the main process.`,
			exitCode: -1,
		};
	}
}
