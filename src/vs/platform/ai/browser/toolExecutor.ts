/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Tool Executor
 *  Runtime implementation of the 11 built-in tools. All subprocess calls are
 *  async (spawn-based) to avoid blocking the Electron render thread.
 *  run_command includes a safe-command whitelist to prevent automatic
 *  execution of potentially destructive shell commands.
 *
 *  NOTE: This code runs in Electron's sandboxed renderer process where
 *  Node.js built-in modules (child_process, path, fs) are NOT available.
 *  We use VS Code's browser-compatible path utilities and IPC for subprocess execution.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer, encodeBase64 } from '../../../base/common/buffer.js';
import { extUri, extUriIgnorePathCase } from '../../../base/common/resources.js';
import { isAbsolute, resolve } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { FileOperationResult, IFileContent, IFileService, toFileOperationResult } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { MarkerSeverity, IMarkerService } from '../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { BuiltInToolName, type AIMessageContent, type AskUserQuestionInput, type SubAgentConfig } from '../common/aiTypes.js';
import { IAIIndexService } from './aiIndexService.js';
import { IDiffStore } from '../../../workbench/contrib/aiDiffApply/browser/diffStore.js';
import type { DiffHunk } from '../../../workbench/contrib/aiDiffApply/common/diffTypes.js';
import { ITaskManager } from '../common/taskManager.js';
import { ISubAgentManager } from '../common/subAgentManager.js';
import type { CommandApprovalHandler, ToolOutcome } from '../common/toolRuntime.js';
import { IUserMemoryStore } from '../common/userMemoryStore.js';
import { getAIStudioIpcRenderer } from '../common/desktopIpc.js';

class ToolFailure extends Error {
	constructor(message: string, readonly outcome: ToolOutcome = 'error') { super(message); }
}

// Auto-approval accepts a single read-only invocation with known options. Anything
// requiring shell expansion, redirection, or an unfamiliar flag goes to approval.
const SAFE_COMMAND_PATTERNS = [
	/^(?:git (?:status|log|show|diff|ls-files|describe|rev-parse|shortlog)|rg|grep|findstr)(?: (?:[\w./~@][\w./~@-]*|--|-[inrsl]+|-\d+|--(?:short|oneline|stat|name-only|name-status|color|all|tags|heads|pretty=oneline)))*$/u,
	/^(?:git (?:branch(?: (?:-a|-r|--all|--remotes|--show-current|--list))?|stash list|remote -v|config --list|tag -l)|npm (?:list|ls|outdated|audit|config list))$/u,
	/^(?:node|python|python3) --version$/u,
	/^(?:dir|ls|pwd|cat|type|echo|where|which|whereis|wc|head|tail|du|diff)(?: (?:[\w./~@][\w./~@-]*|--|-[alhnr]+|-\d+))*$/u,
];

export function isCommandSafe(command: string): boolean {
	if (/[\r\n]/.test(command)) {
		return false;
	}
	const normalized = command.trim().replace(/[ \t]+/g, ' ');
	const args = normalized.split(' ').slice(1);
	if (args.some(arg => arg.startsWith('/') || arg.startsWith('~') || arg.split('/').includes('..') || isSensitiveFile(arg))) {
		return false;
	}
	return SAFE_COMMAND_PATTERNS.some(pattern => pattern.test(normalized));
}

const RG_SHORT_OPTIONS: Record<string, string> = {
	'-e': '--regexp', '-g': '--glob', '-t': '--type', '-T': '--type-not', '-m': '--max-count',
	'-C': '--context', '-A': '--after-context', '-B': '--before-context',
};

type ImageSource = NonNullable<AIMessageContent['source']>;

const SENSITIVE_FILE_PATTERNS = [
	/(?:^|[\\/])\.git(?:[\\/]|$)/i,
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
	'.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.mp3', '.mp4',
	'.avi', '.mov', '.wmv', '.flv', '.doc', '.docx', '.xls',
	'.xlsx', '.ppt', '.pptx', '.wasm', '.o', '.obj', '.class',
	'.pyc', '.pyo', '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

const IMAGE_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
]);

const PDF_EXTENSION = '.pdf';

function isSensitiveFile(filePath: string): boolean {
	return SENSITIVE_FILE_PATTERNS.some(p => p.test(filePath));
}

function isBinaryFile(filePath: string): boolean {
	const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

function isImageFile(filePath: string): boolean {
	const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
	return IMAGE_EXTENSIONS.has(ext);
}

function isPdfFile(filePath: string): boolean {
	const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
	return ext === PDF_EXTENSION;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
};

function getImageMimeType(filePath: string): string {
	const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
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
	let current = '';
	let quote: '"' | '\'' | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) { quote = null; }
			else { current += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (current) { args.push(current); current = ''; }
			continue;
		}
		if (/[;&|<>`$]/.test(ch)) { return null; }
		current += ch;
	}
	if (quote) { return null; }
	if (current) { args.push(current); }
	return args;
}

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

/**
 * Runtime execution engine for AI tools.
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
		private readonly abortSignal?: AbortSignal,
		// Phase 2: new dependencies
		private readonly taskManager?: ITaskManager,
		private readonly subAgentManager?: ISubAgentManager,
		private readonly userMemoryStore?: IUserMemoryStore,
		// Phase 3: interactive callbacks
		private readonly onAskUserQuestion?: (input: AskUserQuestionInput) => Promise<string>,
		private readonly onEnterPlanMode?: () => void,
		private readonly onExitPlanMode?: (planFile: string, content: string) => void,
		private readonly cwdOverride?: string,
		private readonly turn?: { sessionId?: string; requestId?: string },
	) { }

	/**
	 * Entry point for tool dispatch. Routes `toolName` to the matching
	 * private method and returns the tool's string result.
	 */
	async execute(toolName: string, input: Record<string, unknown>, onImage?: (source: ImageSource) => void): Promise<string> {
		return (await this.executeCall(toolName, input, onImage)).text;
	}

	async executeCall(toolName: string, input: Record<string, unknown>, onImage?: (source: ImageSource) => void, approve?: CommandApprovalHandler): Promise<{ text: string; outcome: ToolOutcome }> {
		const fileMutation = toolName === BuiltInToolName.WriteFile || toolName === BuiltInToolName.EditFile;
		try {
			this.abortSignal?.throwIfAborted();
			const text = await this._dispatch(toolName, input, onImage, approve);
			// Once the write and its review record exist, report the committed change even if the turn was stopped.
			if (!fileMutation) { this.abortSignal?.throwIfAborted(); }
			return { text, outcome: 'success' };
		} catch (err) {
			if (this.abortSignal?.aborted && (!fileMutation || err === this.abortSignal.reason)) { return { text: 'Tool execution cancelled', outcome: 'cancelled' }; }
			if (err instanceof ToolFailure) { return { text: err.message, outcome: err.outcome }; }
			this.logService.error('[ToolExecutor] ' + toolName + ':', err);
			return { text: 'Error executing ' + toolName + ': ' + (err instanceof Error ? err.message : String(err)), outcome: 'error' };
		}
	}

	private async _dispatch(toolName: string, input: Record<string, unknown>, onImage?: (source: ImageSource) => void, approve?: CommandApprovalHandler): Promise<string> {
		switch (toolName) {
			case BuiltInToolName.ReadFile: return await this._readFile(input, onImage);
			case BuiltInToolName.WriteFile: return await this._writeFile(input);
			case BuiltInToolName.EditFile: return await this._editFile(input);
			case BuiltInToolName.SearchContent: return await this._searchContent(input);
			case BuiltInToolName.SearchFiles: return await this._searchFiles(input);
			case BuiltInToolName.RunCommand: return this._runCommand(input, approve);
			case BuiltInToolName.ListDirectory: return await this._listDirectory(input);
			case BuiltInToolName.ReadLints: return await this._readLints(input);
			case BuiltInToolName.SearchPattern: return await this._searchPattern(input);
			case BuiltInToolName.WebFetch: return await this._webFetch(input);
			case BuiltInToolName.WebSearch: return await this._webSearch(input);
			case 'TaskCreate':
			case 'TaskUpdate':
			case 'TaskList':
			case 'TaskGet':
			case 'Agent':
			case 'SendMessage':
			case 'LocalMemoryRecall':
			case 'AskUserQuestion':
			case 'EnterPlanMode':
			case 'ExitPlanMode':
				return this._executeAgentTool(toolName, input, approve);
			default: throw new ToolFailure('Error: unknown tool "' + toolName + '"');
		}
	}

	// -- Path helpers ---------------------------------------------------------

	/**
	 * Resolves a workspace-relative (or absolute) path to an absolute path,
	 * validating that it stays inside the workspace root.
	 *
	 * @throws If no workspace is open, or if the path escapes the workspace.
	 */
	private _roots(): readonly URI[] {
		return this.cwdOverride ? [URI.file(this.cwdOverride)] : this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
	}

	private _contains(root: URI, filePath: string): boolean {
		return (isWindows ? extUriIgnorePathCase : extUri).isEqualOrParent(URI.file(filePath), root);
	}

	private _resolvePath(filePath: string): string {
		const roots = this._roots();
		if (!roots.length) { throw new Error('No workspace folder is open.'); }
		const resolved = resolve(roots[0].fsPath, filePath);
		if (!roots.some(root => this._contains(root, resolved))) {
			throw new Error('Path is outside the workspace: ' + filePath);
		}
		return resolved;
	}

	private _getCwd(): string {
		if (this.cwdOverride) { return this.cwdOverride; }
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath || '.';
	}

	// -- Tool implementations -------------------------------------------------

	private async _readFile(input: Record<string, unknown>, onImage?: (source: ImageSource) => void): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		if (isSensitiveFile(fp)) { throw new ToolFailure('Error: cannot read sensitive file: ' + (input.path as string)); }

		// Handle image files — read as binary, base64-encode, return structured result
		if (isImageFile(fp)) {
			const content = await this.fileService.readFile(URI.file(fp));
			const mimeType = getImageMimeType(fp);
			const base64Data = encodeBase64(content.value);
			const size = content.value.byteLength;
			const summary = `[IMAGE: ${input.path} | ${mimeType} | ${size} bytes]`;
			if (onImage) {
				onImage({ type: 'base64', media_type: mimeType, data: base64Data });
				return summary;
			}
			return `${summary} data:${mimeType};base64,${base64Data}`;
		}

		// Handle PDF files — read as binary, indicate limited text extraction capability
		if (isPdfFile(fp)) {
			const content = await this.fileService.readFile(URI.file(fp));
			const size = content.value.byteLength;
			return `[PDF: ${input.path} | ${size} bytes | PDF text extraction requires the main-process PDF handler]`;
		}

		if (isBinaryFile(fp)) { throw new ToolFailure('Error: cannot read binary file: ' + (input.path as string)); }
		const offset = (input.offset as number) || 0;
		const limit = (input.limit as number) || undefined;
		const content = await this.fileService.readFile(URI.file(fp));
		const lines = content.value.toString().split('\n');
		const start = offset > 0 ? offset - 1 : 0;
		const end = limit ? start + limit : lines.length;
		return lines.slice(start, end).map((line: string, i: number) => String(start + i + 1).padStart(4, ' ') + '| ' + line).join('\n');
	}

	private async _writeFile(input: Record<string, unknown>): Promise<string> {
		const uri = URI.file(this._resolvePath(input.path as string));
		if (isSensitiveFile(uri.fsPath)) { throw new ToolFailure('Error: cannot write to sensitive file: ' + input.path); }
		let original: IFileContent | undefined;
		try { original = await this.fileService.readFile(uri); }
		catch (err) {
			if (toFileOperationResult(err) !== FileOperationResult.FILE_NOT_FOUND) { throw err; }
		}
		const before = original?.value.toString() ?? '';
		const after = input.content as string;
		await this._applyFileChange(uri, original, after, {
			id: generateUuid(), filePath: uri.fsPath, status: 'applied',
			kind: original ? 'write' : 'create', modifiedStartColumn: 1,
			originalStartLine: 1, originalEndLine: before.split('\n').length,
			modifiedStartLine: 1, modifiedEndLine: after.split('\n').length,
			originalText: before, modifiedText: after,
		});
		return 'File written: ' + input.path;
	}

	private async _editFile(input: Record<string, unknown>): Promise<string> {
		const uri = URI.file(this._resolvePath(input.path as string));
		if (isSensitiveFile(uri.fsPath)) { throw new ToolFailure('Error: cannot edit sensitive file: ' + input.path); }
		const oldStr = input.old_string as string;
		const newStr = input.new_string as string;
		if (!oldStr) { throw new ToolFailure('Error: old_string must not be empty'); }

		const original = await this.fileService.readFile(uri);
		const text = original.value.toString();
		const index = text.indexOf(oldStr);
		if (index < 0) { throw new ToolFailure('Error: old_string not found in ' + input.path); }
		const after = input.replace_all ? text.split(oldStr).join(newStr) : text.slice(0, index) + newStr + text.slice(index + oldStr.length);
		// A replace-all can edit distant spans. Store one before/after snapshot for that operation.
		const wholeFile = !!input.replace_all && text.indexOf(oldStr, index + oldStr.length) !== -1;
		const prefix = wholeFile ? '' : text.slice(0, index);
		const startLine = prefix.split('\n').length;
		const originalText = wholeFile ? text : oldStr;
		const modifiedText = wholeFile ? after : newStr;
		await this._applyFileChange(uri, original, after, {
			id: generateUuid(), filePath: uri.fsPath, status: 'applied', kind: wholeFile ? 'write' : 'edit',
			modifiedStartColumn: prefix.length - prefix.lastIndexOf('\n'),
			originalStartLine: startLine, originalEndLine: startLine + originalText.split('\n').length - 1,
			modifiedStartLine: startLine, modifiedEndLine: startLine + modifiedText.split('\n').length - 1,
			originalText, modifiedText,
			beforeAnchor: wholeFile ? undefined : prefix.slice(-64),
			afterAnchor: wholeFile ? undefined : after.slice(index + modifiedText.length, index + modifiedText.length + 64),
		});
		return 'File edited: ' + input.path;
	}

	private async _applyFileChange(uri: URI, original: IFileContent | undefined, text: string, hunk: DiffHunk): Promise<void> {
		this.abortSignal?.throwIfAborted();
		const updated = VSBuffer.fromString(text);
		if (original) {
			await this.fileService.writeFile(uri, updated, { etag: original.etag, mtime: original.mtime });
		} else {
			await this.fileService.createFile(uri, updated, { overwrite: false });
		}
		try {
			this.abortSignal?.throwIfAborted();
			this.diffStore.addGroup({ id: generateUuid(), chatMessageId: this.turn?.requestId ?? '', sessionId: this.turn?.sessionId, hunks: [hunk], createdAt: Date.now() });
		} catch (err) {
			// Move first: pending writes to the public path must not be overwritten
			// just because they have the same length as the agent's last write.
			const recovery = URI.joinPath(uri, '..', '.ai-studio-rollback-' + generateUuid());
			await this.fileService.move(uri, recovery, false);
			try {
				const captured = await this.fileService.readFile(recovery);
				const isOurWrite = captured.value.equals(updated);
				if (isOurWrite && !original) {
					await this.fileService.del(recovery);
				} else {
					if (isOurWrite && original) {
						// Updating the captured inode preserves executable bits and ownership.
						await this.fileService.writeFile(recovery, original.value);
					}
					const ipc = getAIStudioIpcRenderer();
					if (ipc) {
						await ipc.invoke('vscode:ai-studio:restoreRollback', recovery.fsPath, uri.fsPath);
						await this.fileService.del(recovery);
					} else {
						await this.fileService.move(recovery, uri, false);
					}
				}
			} catch (recoveryError) {
				throw new Error('Recovery file: ' + recovery.fsPath + '. Could not restore: ' + recoveryError + '. Original error: ' + err);
			}
			throw err;
		}
	}

	private async _searchContent(input: Record<string, unknown>): Promise<string> {
		const pattern = input.pattern as string;
		if (this.cwdOverride) {
			const result = await this._spawn('rg', ['--no-config', '--line-number', '--fixed-strings', '--', pattern, '.'], this.cwdOverride, 15000, 5 * 1024 * 1024);
			if (result.exitCode === 1) { return 'No matches.'; }
			if (result.exitCode !== 0) { throw new ToolFailure('Search error: ' + result.stderr); }
			return result.stdout;
		}
		try {
			const results = await this.indexService.search(pattern, 10);
			if (!results.length) { return 'No results for "' + pattern + '".'; }
			return results.map(r => r.filePath + ':' + r.startLine + '\n' + r.content).join('\n---\n');
		} catch (err) { throw new ToolFailure('Search error: ' + (err instanceof Error ? err.message : String(err))); }
	}

	private async _searchPattern(input: Record<string, unknown>): Promise<string> {
		const words = parseSimpleArgs(input.rg_args as string);
		if (!words) { throw new ToolFailure('Error: ripgrep arguments contain unsupported shell syntax.'); }
		const options = ['--no-config'];
		const operands: string[] = [];
		let explicitPattern = false;
		let endOfOptions = false;
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (endOfOptions || !word.startsWith('-')) { operands.push(word); continue; }
			if (word === '--') { endOfOptions = true; continue; }
			if (/^-[ilnsSHvFwxoc]+$/.test(word) || /^--(?:line-number|files-with-matches|count|count-matches|fixed-strings|ignore-case|smart-case|case-sensitive|word-regexp|line-regexp|hidden|multiline|no-heading|with-filename|only-matching|invert-match)$/.test(word)) {
				options.push(word);
				continue;
			}
			// Accept only options that describe a search. Flags such as --file and --pre
			// would read arbitrary files or execute an external program.
			const option = /^(--(?:regexp|glob|iglob|type|type-not|max-count|context|before-context|after-context)|-[egtTmCAB])(?:=(.*))?$/.exec(word);
			if (!option) { throw new ToolFailure('Error: unsupported ripgrep option: ' + word); }
			const value = option[2] ?? words[++i];
			if (value === undefined) { throw new ToolFailure('Error: missing value for ' + option[1]); }
			options.push((RG_SHORT_OPTIONS[option[1]] ?? option[1]) + '=' + value);
			if (option[1] === '-e' || option[1] === '--regexp') { explicitPattern = true; }
		}
		if (!explicitPattern) {
			const pattern = operands.shift();
			if (pattern === undefined) { throw new ToolFailure('Error: a search pattern is required.'); }
			options.push('--regexp=' + pattern);
		}
		const roots = this._roots();
		if (!roots.length) { throw new ToolFailure('Error: no workspace folder is open.'); }
		const output: string[] = [];
		for (const root of roots) {
			const paths: string[] = [];
			for (const operand of operands) {
				const path = resolve(root.fsPath, operand);
				if (this._contains(root, path)) { paths.push(path); }
				else if (!isAbsolute(operand) || !roots.some(other => this._contains(other, path))) {
					throw new ToolFailure('Error: path is outside the workspace: ' + operand);
				}
			}
			if (operands.length && !paths.length) { continue; }
			const result = await this._spawn('rg', [...options, '--', ...(paths.length ? paths : ['.'])], root.fsPath, 15_000, 5 * 1024 * 1024);
			if (result.exitCode !== 0 && result.exitCode !== 1) { throw new ToolFailure('Search error: ' + result.stderr); }
			const text = result.stdout.trim();
			if (text) { output.push(roots.length > 1 ? root.fsPath + ':\n' + text : text); }
		}
		return output.join('\n').split('\n').slice(0, 100).join('\n') || 'No matches found.';
	}

	private async _searchFiles(input: Record<string, unknown>): Promise<string> {
		const pattern = input.pattern as string;
		const roots = this._roots();
		if (!roots.length) { throw new ToolFailure('Error: no workspace folder is open.'); }
		const files: string[] = [];
		for (const root of roots) {
			let paths: string[];
			try {
				const result = await this._spawn('rg', ['--no-config', '--files', '--glob=' + pattern], root.fsPath, 10_000, 5 * 1024 * 1024);
				if (result.exitCode < 0) { throw new Error(result.stderr); }
				paths = result.stdout.trim().split('\n').filter(Boolean);
			} catch (err) {
				if (this.abortSignal?.aborted) { throw err; }
				paths = await this._walkFiles(root, pattern);
			}
			for (const path of paths) {
				files.push(roots.length === 1 ? path : resolve(root.fsPath, path));
				if (files.length === 50) { return files.join('\n'); }
			}
		}
		return files.length ? files.join('\n') : 'No files matching "' + pattern + '".';
	}

	private async _walkFiles(root: URI, pattern: string): Promise<string[]> {
		const files: string[] = [];
		const excluded = new Set(['.git', 'node_modules', '.ai-studio', 'out', 'dist', '.build']);
		const pending = [root];
		const match = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
		while (pending.length && files.length < 50) {
			this.abortSignal?.throwIfAborted();
			const dir = pending.pop()!;
			const children = (await this.fileService.resolve(dir)).children;
			for (const child of children ?? []) {
				if (child.isDirectory) {
					if (!child.isSymbolicLink && !excluded.has(child.name)) { pending.push(child.resource); }
				} else if (match.test(child.name)) { files.push(child.resource.fsPath); }
			}
		}
		return files;
	}

	private async _runCommand(input: Record<string, unknown>, approve?: CommandApprovalHandler): Promise<string> {
		const cmd = input.command as string;
		if (hasShellInjection(cmd)) {
			throw new ToolFailure('[BLOCKED] Command contains potentially unsafe shell constructs: ' + cmd.slice(0, 80), 'denied');
		}
		const timeout = (input.timeout as number) || 120_000;
		const cwd = this._getCwd();

		// Check approval policy
		const approval = this.configurationService.getValue<string>('ai.commandApproval') || 'unsafe';
		const checkApproval = async () => {
			if (!approve) { throw new ToolFailure('[REQUIRES_APPROVAL] Command: ' + cmd, 'denied'); }
			const allowed = await approve(cmd, cwd, this.abortSignal);
			this.abortSignal?.throwIfAborted();
			if (!allowed) { throw new ToolFailure('Command declined by user.', 'denied'); }
		};
		const safe = isCommandSafe(cmd);
		if (approval !== 'none' && (approval !== 'unsafe' || !safe)) { await checkApproval(); }

		try {
			let result;
			if (approval === 'unsafe' && safe && /^git\s/.test(cmd.trim())) {
				const [subcommand, ...args] = cmd.trim().split(/\s+/).slice(1);
				const gitOptions = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
				if (['status', 'log', 'show', 'diff'].includes(subcommand)) {
					// Inspect only config names: clean/process filters may run even on read-only Git operations.
					const filters = await this._spawn('git', [...gitOptions, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'], cwd, timeout, 4096);
					if (filters.exitCode !== 1) { await checkApproval(); }
				}
				if (['log', 'show', 'diff'].includes(subcommand)) { args.unshift('--no-ext-diff', '--no-textconv'); }
				result = await this._spawn('git', [...gitOptions, subcommand, ...args], cwd, timeout, 10 * 1024 * 1024);
			} else {
				result = await this._spawn(cmd, [], cwd, timeout, 10 * 1024 * 1024, true);
			}
			if (result.exitCode === 0) {
				return result.stdout || '(no output)';
			}
			throw new ToolFailure('Command failed (exit ' + result.exitCode + '): ' + (result.stderr || result.stdout || 'unknown error'));
		} catch (err) {
			if (err instanceof ToolFailure) { throw err; }
			throw new ToolFailure('Command error: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	private async _listDirectory(input: Record<string, unknown>): Promise<string> {
		const fp = this._resolvePath(input.path as string);
		const stat = await this.fileService.resolve(URI.file(fp));
		if (!stat.children) { return '(empty) ' + (input.path as string); }
		return stat.children.map(c => (c.isDirectory ? '[DIR] ' : '[FILE] ') + c.name).join('\n');
	}

	private async _readLints(input: Record<string, unknown>): Promise<string> {
		const fp = input.path as string | undefined;
		if (fp) {
			const markers = this.markerService.read({ resource: URI.file(this._resolvePath(fp)) });
			if (!markers.length) { return 'No issues for ' + fp; }
			return markers.map(m => {
				const s = m.severity === MarkerSeverity.Error ? 'ERROR' : m.severity === MarkerSeverity.Warning ? 'WARN' : 'INFO';
				return '[' + s + '] ' + fp + ':' + m.startLineNumber + ':' + m.startColumn + ' ' + m.message;
			}).join('\n');
		}
		const all = this.cwdOverride
			? this.markerService.read().filter(marker => this._contains(URI.file(this.cwdOverride!), marker.resource.fsPath)).slice(0, 50)
			: this.markerService.read({ take: 50 });
		return all.length ? all.map(m => {
			const s = m.severity === MarkerSeverity.Error ? 'ERROR' : m.severity === MarkerSeverity.Warning ? 'WARN' : 'INFO';
			return '[' + s + '] ' + m.resource.fsPath + ':' + m.startLineNumber + ' ' + m.message;
		}).join('\n') : 'No issues workspace-wide.';
	}

	// -- Web tools --------------------------------------------------------------

	private async _webFetch(input: Record<string, unknown>): Promise<string> {
		const url = input.url as string;
		if (!url) { throw new ToolFailure('Error: url is required'); }
		// Basic URL validation
		try { new URL(url); } catch { throw new ToolFailure('Error: invalid URL: ' + url); }
		// Only allow http/https
		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			throw new ToolFailure('Error: only http/https URLs are supported');
		}
		const prompt = (input.prompt as string) || 'Summarize the content';
		try {
			const html = await this._invokeCancellable<string>('vscode:ai-studio:webFetch', { url });
			// Strip HTML tags and return text
			const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
				.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#\d+;/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 8000);
			return `## Web Content from ${url}\n\nExtraction prompt: ${prompt}\n\n${text}`;
		} catch (err) {
			throw new ToolFailure('Error fetching URL: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	private async _webSearch(input: Record<string, unknown>): Promise<string> {
		const text = await this._invokeCancellable<string>('vscode:ai-studio:webSearch', { query: input.query, num_results: input.num_results });
		if (text.startsWith('Error searching:')) { throw new ToolFailure(text); }
		return text;
	}

	// -- Subprocess execution (IPC via vscode sandbox globals) -----------------

	private async _spawn(command: string, args: string[], cwd: string, timeout: number, maxBuffer: number, shell = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this._invokeCancellable('vscode:ai-studio:exec', { command, args, cwd, timeout, maxBuffer, shell });
	}

	private async _invokeCancellable<T>(channel: string, options: Record<string, unknown>): Promise<T> {
		if (this.abortSignal?.aborted) {
			throw new Error('Tool execution cancelled');
		}
		const ipc = getAIStudioIpcRenderer();
		if (!ipc?.invoke) {
			throw new Error('This tool requires the AI Studio desktop process.');
		}
		const requestId = generateUuid();
		const onAbort = () => {
			void ipc.invoke('vscode:ai-studio:cancelExec', requestId).catch((err: unknown) => this.logService.warn('[ToolExecutor] cancelling command:', err));
		};
		this.abortSignal?.addEventListener('abort', onAbort, { once: true });
		try {
			return await ipc.invoke<T>(channel, { ...options, requestId });
		} finally {
			this.abortSignal?.removeEventListener('abort', onAbort);
		}
	}

	// -- Agent orchestration tools (Phase 2) ----------------------------------

	private async _executeAgentTool(toolName: string, input: Record<string, unknown>, approve?: CommandApprovalHandler): Promise<string> {
		switch (toolName) {
			case 'TaskCreate': {
				if (!this.taskManager) { throw new ToolFailure('Error: TaskManager not available'); }
				try {
					const task = this.taskManager.create(
						input.subject as string,
						input.description as string,
						input.activeForm as string | undefined,
						input.blocks as string[] | undefined,
						input.blockedBy as string[] | undefined,
						input.metadata as Record<string, unknown> | undefined,
					);
					return `Task created: ${task.id} \u2014 "${task.subject}"`;
				} catch (err) {
					throw new ToolFailure(`Error creating task: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			case 'TaskUpdate': {
				if (!this.taskManager) { throw new ToolFailure('Error: TaskManager not available'); }
				try {
					const patch: Parameters<ITaskManager['update']>[1] = {};
					if (input.status !== undefined) { patch.status = input.status as NonNullable<typeof patch.status>; }
					if (input.owner !== undefined) { patch.owner = input.owner as string; }
					if (input.subject !== undefined) { patch.subject = input.subject as string; }
					if (input.description !== undefined) { patch.description = input.description as string; }
					if (input.activeForm !== undefined) { patch.activeForm = input.activeForm as string; }
					if (input.addBlocks !== undefined) { patch.addBlocks = input.addBlocks as string[]; }
					if (input.addBlockedBy !== undefined) { patch.addBlockedBy = input.addBlockedBy as string[]; }
					const updated = this.taskManager.update(input.id as string, patch);
					if (!updated) { throw new ToolFailure(`Error: Task "${input.id}" not found`); }
					return `Task "${updated.id}" updated \u2014 status: ${updated.status}`;
				} catch (err) {
					throw new ToolFailure(`Error updating task: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			case 'TaskList': {
				if (!this.taskManager) { throw new ToolFailure('Error: TaskManager not available'); }
				const tasks = this.taskManager.list();
				if (!tasks.length) { return 'No tasks.'; }
				return tasks.map(t =>
					`- [${t.status}] ${t.id}: ${t.subject}` +
					(t.owner ? ` (owner: ${t.owner})` : '') +
					(t.blockedBy.length ? ` blockedBy: [${t.blockedBy.join(', ')}]` : '') +
					(t.blocks.length ? ` blocks: [${t.blocks.join(', ')}]` : '')
				).join('\n');
			}

			case 'TaskGet': {
				if (!this.taskManager) { throw new ToolFailure('Error: TaskManager not available'); }
				const task = this.taskManager.get(input.id as string);
				if (!task) { throw new ToolFailure(`Task "${input.id}" not found`); }
				return JSON.stringify(task, null, 2);
			}

			case 'Agent': {
				if (!this.subAgentManager) { throw new ToolFailure('Error: SubAgentManager not available'); }
				const configs: SubAgentConfig[] = [{
					subagent_type: (input.subagent_type as SubAgentConfig['subagent_type'] | undefined) || 'general-purpose',
					description: (input.description as string) || 'No description',
					prompt: input.prompt as string,
					name: input.name as string | undefined,
					run_in_background: !!(input.run_in_background as boolean),
					mode: (input.mode as SubAgentConfig['mode'] | undefined) || 'default',
					isolation: input.isolation as 'worktree' | undefined,
				}];
				try {
					const results = await this.subAgentManager.execute(configs, { ...this.turn, signal: this.abortSignal, approve });
					const r = results[0];
					if (r.status === 'aborted') { throw new ToolFailure('Tool execution cancelled', 'cancelled'); }
					if (r.status === 'error') { throw new ToolFailure(`Sub-agent "${r.name}" error: ${r.error}`); }
					return `Sub-agent "${r.name}" completed. Tool calls: ${r.toolCalls}\n\n${r.text}`;
				} catch (err) {
					if (err instanceof ToolFailure) { throw err; }
					throw new ToolFailure(`Sub-agent error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			case 'SendMessage': {
				if (!this.subAgentManager) { throw new ToolFailure('Error: SubAgentManager not available'); }
				const to = input.to as string;
				const summary = (input.summary as string) || '';
				const message = input.message as string;
				this.subAgentManager.sendMessage('parent', to, summary, message);
				return `Message sent to ${to}`;
			}

			case 'LocalMemoryRecall': {
				if (!this.userMemoryStore) { throw new ToolFailure('Error: UserMemoryStore not available'); }
				const query = (input.query as string || '').toLowerCase();
				const entries = await this.userMemoryStore.list();
				if (!entries.length) { return 'No memories found.'; }
				const matched = entries.filter(e =>
					e.name.toLowerCase().includes(query) ||
					e.description.toLowerCase().includes(query)
				);
				if (!matched.length) { return `No memories matching "${input.query}".`; }
				return matched.map(e => `## ${e.name} (${e.type})\n${e.description}\n\n${e.content}`).join('\n\n---\n\n');
			}

			case 'AskUserQuestion': {
				if (!this.onAskUserQuestion) { throw new ToolFailure('Error: AskUserQuestion not available'); }
				const qInput: AskUserQuestionInput = {
					question: input.question as string,
					header: input.header as string | undefined,
					options: (input.options as AskUserQuestionInput['options'] | undefined) || [],
					multiSelect: !!(input.multiSelect as boolean),
				};
				try {
					const answer = await this.onAskUserQuestion(qInput);
					return answer;
				} catch (err) {
					throw new ToolFailure(`Error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			case 'EnterPlanMode': {
				this.onEnterPlanMode?.();
				return 'Entered plan mode. Explore using read-only tools, then submit the plan text with ExitPlanMode.';
			}

			case 'ExitPlanMode': {
				const planFile = typeof input.planFile === 'string' ? input.planFile : undefined;
				let content = typeof input.content === 'string' ? input.content.trim() : '';
				if (!content && planFile) {
					const path = this._resolvePath(planFile);
					if (isSensitiveFile(path)) { throw new ToolFailure('Cannot present a sensitive file.', 'denied'); }
					content = (await this.fileService.readFile(URI.file(path))).value.toString();
				}
				if (!content) { throw new ToolFailure('Error: a nonempty plan is required'); }
				this.onExitPlanMode?.(planFile ?? '', content);
				return 'Plan presented for approval. Waiting for user decision.';
			}

			default:
				throw new ToolFailure(`Error: unknown agent tool "${toolName}"`);
		}
	}
}
