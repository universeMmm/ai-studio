/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionRequest } from '@github/copilot-sdk';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { appendEscapedMarkdownInlineCode, escapeMarkdownLinkLabel } from '../../../../base/common/htmlContent.js';
import { hash } from '../../../../base/common/hash.js';
import { localize } from '../../../../nls.js';
import type { IAgentToolPendingConfirmationSignal } from '../../common/agentService.js';
import { stripRedundantCdPrefix } from '../../common/commandLineHelpers.js';
import { StringOrMarkdown } from '../../common/state/protocol/state.js';
import { basename } from '../../../../base/common/resources.js';

// =============================================================================
// Copilot CLI built-in tool interfaces
//
// The Copilot CLI (via @github/copilot-sdk) exposes these built-in tools. Tool names
// and parameter shapes are not typed in the SDK -- they come from the CLI server
// as plain strings. These interfaces are derived from observing the CLI's actual
// tool events and the AI Studio Chat CLI display table.
//
// Shell tool names follow a pattern per ShellConfig:
//   shellToolName, readShellToolName, writeShellToolName,
//   stopShellToolName, listShellsToolName
// For bash: bash, read_bash, write_bash, stop_bash/bash_shutdown, list_bash
// For powershell: powershell, read_powershell, write_powershell, stop_powershell/powershell_shutdown, list_powershell
// =============================================================================

/**
 * Known Copilot CLI tool names. These are the `toolName` values that appear
 * in `tool.execution_start` events from the SDK.
 */
const enum AgentToolName {
	StrReplaceEditor = 'str_replace_editor',
	StrReplace = 'str_replace',
	Insert = 'insert',

	Bash = 'bash',
	ReadBash = 'read_bash',
	WriteBash = 'write_bash',
	StopBash = 'stop_bash',
	BashShutdown = 'bash_shutdown',
	ListBash = 'list_bash',

	PowerShell = 'powershell',
	ReadPowerShell = 'read_powershell',
	WritePowerShell = 'write_powershell',
	StopPowerShell = 'stop_powershell',
	PowerShellShutdown = 'powershell_shutdown',
	ListPowerShell = 'list_powershell',

	View = 'view',
	Edit = 'edit',
	Create = 'create',
	Grep = 'grep',
	Rg = 'rg',
	Glob = 'glob',
	SearchCodeSubagent = 'search_code_subagent',
	ReplyToComment = 'reply_to_comment',
	CodeReview = 'code_review',
	ApplyPatch = 'apply_patch',
	GitApplyPatch = 'git_apply_patch',
	WebSearch = 'web_search',
	WebFetch = 'web_fetch',
	AskUser = 'ask_user',
	ReportIntent = 'report_intent',
	Think = 'think',
	ReportProgress = 'report_progress',
	UpdateTodo = 'update_todo',
	ShowFile = 'show_file',
	FetchCopilotCliDocumentation = 'fetch_copilot_cli_documentation',
	ProposeWork = 'propose_work',
	TaskComplete = 'task_complete',
	Skill = 'skill',
	Task = 'task',
	ListAgents = 'list_agents',
	ReadAgent = 'read_agent',
	ExitPlanMode = 'exit_plan_mode',
	Sql = 'sql',
	Lsp = 'lsp',
	CreatePullRequest = 'create_pull_request',
	GhAdvisoryDatabase = 'gh-advisory-database',
	StoreMemory = 'store_memory',
	ParallelValidation = 'parallel_validation',
	WriteAgent = 'write_agent',
	McpReload = 'mcp_reload',
	McpValidate = 'mcp_validate',
	ToolSearchToolRegex = 'tool_search_tool_regex',
	CodeqlChecker = 'codeql_checker',
}

/** Parameters for the `bash` / `powershell` shell tools. */
interface IAgentShellToolArgs {
	command: string;
	timeout?: number;
}

/** Parameters for file tools (`view`, `edit`, `create`). */
interface IAgentFileToolArgs {
	path: string;
}

/**
 * Parameters for the `view` tool. The Copilot CLI accepts an optional
 * `view_range: [startLine, endLine]` (1-based, inclusive). `endLine` may be
 * `-1` to mean "to end of file".
 */
interface IAgentViewToolArgs extends IAgentFileToolArgs {
	view_range?: number[];
}

/**
 * Normalizes a `view_range` array. Returns `undefined` unless the array has
 * exactly two integer elements with `startLine >= 0`. `endLine === -1` is
 * preserved as the "to end of file" sentinel; otherwise `endLine` must be
 * `>= startLine`.
 */
function formatViewRange(view_range: number[] | undefined): { startLine: number; endLine: number } | undefined {
	if (!Array.isArray(view_range) || view_range.length !== 2) {
		return undefined;
	}
	const [startLine, endLine] = view_range;
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
		return undefined;
	}
	if (startLine < 0) {
		return undefined;
	}
	if (endLine !== -1 && endLine < startLine) {
		return undefined;
	}
	return { startLine, endLine };
}

/**
 * Parameters for the `grep` tool. The Copilot CLI's `grep` accepts the same
 * rich rg-flag schema as `rg`; the older narrower shape (e.g. `include`) is
 * no longer used.
 */
interface IAgentGrepToolArgs {
	pattern: string;
	path?: string;
	output_mode?: 'content' | 'files_with_matches' | 'count';
	glob?: string;
	type?: string;
	'-i'?: boolean;
	'-A'?: number;
	'-B'?: number;
	'-C'?: number;
	'-n'?: boolean;
	head_limit?: number;
	multiline?: boolean;
}

/**
 * Parameters for the `rg` tool. Mirrors {@link IAgentGrepToolArgs} today but
 * is kept as a distinct interface so the two tools can drift independently if
 * the SDK ever differentiates them.
 */
interface IAgentRgToolArgs {
	pattern: string;
	path?: string;
	output_mode?: 'content' | 'files_with_matches' | 'count';
	glob?: string;
	type?: string;
	'-i'?: boolean;
	'-A'?: number;
	'-B'?: number;
	'-C'?: number;
	'-n'?: boolean;
	head_limit?: number;
	multiline?: boolean;
}

/** Parameters for the `glob` tool. */
interface IAgentGlobToolArgs {
	pattern: string;
	path?: string;
}

/** Parameters for the `sql` tool. */
interface IAgentSqlToolArgs {
	description?: string;
	query?: string;
}

/**
 * Parameters for the `apply_patch` / `git_apply_patch` tools. The patch text
 * itself lives in `input` using the V4A diff format (file headers like
 * `*** Update File: <path>`), so file paths must be parsed out of the body
 * rather than read from a top-level field.
 */
interface IAgentApplyPatchToolArgs {
	input?: string;
	/** Some SDK callers send the patch under `patch` instead of `input`. */
	patch?: string;
	explanation?: string;
}

/**
 * Headers of the V4A patch format the `apply_patch` tool accepts. Tolerates
 * leading whitespace; trims the captured path.
 */
const APPLY_PATCH_FILE_HEADERS = [
	/^\s*\*\*\*\s+Update File:\s*(.+?)\s*$/,
	/^\s*\*\*\*\s+Add File:\s*(.+?)\s*$/,
	/^\s*\*\*\*\s+Delete File:\s*(.+?)\s*$/,
	/^\s*\*\*\*\s+Move to:\s*(.+?)\s*$/,
];

/**
 * Extracts the set of file paths affected by an `apply_patch` payload. Reads
 * the `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:`
 * headers from the V4A diff body. Returns paths in document order with
 * duplicates removed.
 *
 * Accepts either a structured args object ({@link IAgentApplyPatchToolArgs})
 * or a bare patch string. The Copilot SDK delivers `apply_patch` with
 * `arguments` as a raw V4A patch string (custom tool format), not as a JSON
 * object, so the string fallback is the common case for apply_patch.
 */
function getApplyPatchFiles(args: string | IAgentApplyPatchToolArgs | undefined): string[] {
	const text = typeof args === 'string' ? args : (args?.input ?? args?.patch);
	if (typeof text !== 'string' || text.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of text.split('\n')) {
		for (const re of APPLY_PATCH_FILE_HEADERS) {
			const m = re.exec(line);
			if (m) {
				const path = m[1];
				if (path && !seen.has(path)) {
					seen.add(path);
					out.push(path);
				}
				break;
			}
		}
	}
	return out;
}

/** Set of tool names that perform file edits. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.Edit,
	AgentToolName.StrReplace,
	AgentToolName.Insert,
	AgentToolName.Create,
	AgentToolName.ApplyPatch,
	AgentToolName.GitApplyPatch,
]);

const STR_REPLACE_EDITOR_EDIT_COMMANDS: ReadonlySet<string> = new Set([
	AgentToolName.Edit,
	AgentToolName.StrReplace,
	AgentToolName.Insert,
	AgentToolName.Create,
]);

/**
 * Returns true if the tool modifies files on disk.
 */
export function isEditTool(toolName: string, command?: string): boolean {
	if (EDIT_TOOL_NAMES.has(toolName)) {
		return true;
	}
	if (toolName === AgentToolName.StrReplaceEditor) {
		return command !== undefined && STR_REPLACE_EDITOR_EDIT_COMMANDS.has(command);
	}
	return false;
}

/**
 * Extracts the target file path from an edit tool's parameters, if available.
 * For `apply_patch` / `git_apply_patch` the first file in the V4A patch body
 * is returned. Callers that need every affected file (for snapshotting all
 * edits in a multi-file patch) should use {@link getEditFilePaths} instead.
 */
export function getEditFilePath(parameters: unknown): string | undefined {
	return getEditFilePaths(parameters)[0];
}

/**
 * Extracts every file path an edit tool will touch. For `edit` / `create` this
 * is the single `path` parameter; for `apply_patch` / `git_apply_patch` this
 * is the unique set of files declared in the V4A patch body, in document
 * order. Returns an empty array if no paths can be determined.
 */
export function getEditFilePaths(parameters: unknown): string[] {
	if (typeof parameters === 'string') {
		// Could be either a JSON-encoded args object or a raw V4A patch
		// string. Copilot SDK delivers `apply_patch` arguments as a bare
		// patch string (custom tool format), so when JSON parsing fails
		// fall back to treating it as the patch body.
		try {
			parameters = JSON.parse(parameters);
		} catch {
			return getApplyPatchFiles(parameters as string);
		}
		// JSON.parse may have returned a string (e.g. a JSON-encoded patch
		// body that round-trips through tryStringify on the call site).
		if (typeof parameters === 'string') {
			return getApplyPatchFiles(parameters);
		}
	}

	if (!parameters || typeof parameters !== 'object') {
		return [];
	}

	const patchArgs = parameters as IAgentApplyPatchToolArgs;
	if (typeof patchArgs.input === 'string' || typeof patchArgs.patch === 'string') {
		return getApplyPatchFiles(patchArgs);
	}

	const args = parameters as IAgentFileToolArgs;
	return typeof args.path === 'string' ? [args.path] : [];
}

/** Set of tool names that execute shell commands (bash or powershell). */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.Bash,
	AgentToolName.PowerShell,
]);

/** Set of tool names that write input to an interactive shell session. */
const WRITE_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.WriteBash,
	AgentToolName.WritePowerShell,
]);

/** Set of tool names that read output from an interactive shell session. */
const READ_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.ReadBash,
	AgentToolName.ReadPowerShell,
]);

/** Set of tool names that spawn subagent sessions. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	'task',
]);

/** Set of tool names that perform file/text search. */
const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.Grep,
	AgentToolName.Rg,
	AgentToolName.Glob,
]);

/**
 * Tools that should not be shown to the user. These are internal tools
 * used by the CLI for its own purposes (e.g., reporting intent to the model).
 *
 * `skill` is hidden because the SDK already emits a richer `skill.invoked`
 * lifecycle event with the resolved skill file path; the agent session
 * synthesizes a tool-start/complete pair from that event so the UI can
 * render a clickable file link instead of just the skill name. See
 * {@link synthesizeSkillToolCall}.
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
	AgentToolName.ReportIntent,
	AgentToolName.Skill,
]);

/**
 * Returns true if the tool should be hidden from the UI.
 */
export function isHiddenTool(toolName: string): boolean {
	return HIDDEN_TOOL_NAMES.has(toolName);
}

/**
 * Returns true if the tool executes shell commands.
 */
export function isShellTool(toolName: string): boolean {
	return SHELL_TOOL_NAMES.has(toolName);
}

// =============================================================================
// Display helpers
//
// These functions translate Copilot CLI tool names and arguments into
// human-readable display strings. This logic lives here -- in the agent-host
// process -- so the IPC protocol stays agent-agnostic; the renderer never needs
// to know about specific tool names.
// =============================================================================

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

/**
 * Formats a file path as a markdown link `[](file-uri)` so it renders
 * as a clickable file widget in the chat UI.
 */
function formatPathAsMarkdownLink(path: string): string {
	const uri = URI.file(path);
	return `[${basename(uri)}](${uri})`;
}

/**
 * Wraps a localized message containing a markdown file link into a
 * `StringOrMarkdown` object so the renderer treats it as markdown.
 */
function md(value: string): StringOrMarkdown {
	return { markdown: value };
}

export function getToolDisplayName(toolName: string): string {
	switch (toolName) {
		case AgentToolName.StrReplaceEditor:
		case AgentToolName.Edit:
		case AgentToolName.StrReplace:
		case AgentToolName.Insert: return localize('toolName.edit', "Edit File");
		case AgentToolName.Create: return localize('toolName.create', "Create File");
		case AgentToolName.View: return localize('toolName.read', "Read");
		case AgentToolName.Bash:
		case AgentToolName.PowerShell: return localize('toolName.shell', "Run Shell Command");
		case AgentToolName.ReadBash:
		case AgentToolName.ReadPowerShell: return localize('toolName.readTerminal', "Read Terminal");
		case AgentToolName.WriteBash: return localize('toolName.writeBash', "Write to Bash");
		case AgentToolName.WritePowerShell: return localize('toolName.writePowerShell', "Write to PowerShell");
		case AgentToolName.StopBash:
		case AgentToolName.StopPowerShell:
		case AgentToolName.BashShutdown:
		case AgentToolName.PowerShellShutdown: return localize('toolName.stopShell', "Stop Terminal Session");
		case AgentToolName.ListBash:
		case AgentToolName.ListPowerShell: return localize('toolName.listShellSessions', "List Shell Sessions");
		case AgentToolName.Grep:
		case AgentToolName.Rg:
		case AgentToolName.Glob: return localize('toolName.search', "Search");
		case AgentToolName.SearchCodeSubagent: return localize('toolName.searchCode', "Search Code");
		case AgentToolName.ApplyPatch: return localize('toolName.applyPatch', "Apply Patch");
		case AgentToolName.GitApplyPatch: return localize('toolName.patch', "Patch");
		case AgentToolName.CodeqlChecker: return localize('toolName.codeqlChecker', "CodeQL Security Scan");
		case AgentToolName.CodeReview: return localize('toolName.codeReview', "Code Review");
		case AgentToolName.ReplyToComment: return localize('toolName.replyToComment', "Reply to Comment");
		case AgentToolName.Think: return localize('toolName.think', "Thinking");
		case AgentToolName.ReportIntent: return localize('toolName.reportIntent', "Report Intent");
		case AgentToolName.ReportProgress: return localize('toolName.reportProgress', "Progress update");
		case AgentToolName.WebSearch: return localize('toolName.webSearch', "Web Search");
		case AgentToolName.WebFetch: return localize('toolName.fetchWebContent', "Fetch Web Content");
		case AgentToolName.UpdateTodo: return localize('toolName.updateTodo', "Update Todo");
		case AgentToolName.ShowFile: return localize('toolName.showFile', "Show File");
		case AgentToolName.FetchCopilotCliDocumentation: return localize('toolName.fetchAiStudioCliDocumentation', "Fetch Documentation");
		case AgentToolName.ProposeWork: return localize('toolName.proposeWork', "Propose Work");
		case AgentToolName.TaskComplete: return localize('toolName.taskComplete', "Task Complete");
		case AgentToolName.AskUser: return localize('toolName.askUser', "Ask User");
		case AgentToolName.Skill: return localize('toolName.invokeSkill', "Invoke Skill");
		case AgentToolName.Task: return localize('toolName.task', "Delegate Task");
		case AgentToolName.ListAgents: return localize('toolName.listAgents', "List Agents");
		case AgentToolName.ReadAgent: return localize('toolName.readAgent', "Read Agent");
		case AgentToolName.ExitPlanMode: return localize('toolName.exitPlanModeFull', "Exit Plan Mode");
		case AgentToolName.Sql: return localize('toolName.sql', "Execute SQL");
		case AgentToolName.Lsp: return localize('toolName.lsp', "Language Server");
		case AgentToolName.CreatePullRequest: return localize('toolName.createPullRequest', "Create Pull Request");
		case AgentToolName.GhAdvisoryDatabase: return localize('toolName.ghAdvisoryDatabase', "Check Dependencies");
		case AgentToolName.StoreMemory: return localize('toolName.storeMemory', "Store Memory");
		case AgentToolName.ParallelValidation: return localize('toolName.parallelValidation', "Validate Changes");
		case AgentToolName.WriteAgent: return localize('toolName.writeAgent', "Write to Agent");
		case AgentToolName.McpReload: return localize('toolName.mcpReload', "Reload MCP Config");
		case AgentToolName.McpValidate: return localize('toolName.mcpValidate', "Validate MCP Config");
		case AgentToolName.ToolSearchToolRegex: return localize('toolName.toolSearchToolRegex', "Search Tools");
		default: return toolName;
	}
}

export function getInvocationMessage(toolName: string, displayName: string, parameters: Record<string, unknown> | undefined): StringOrMarkdown {
	if (SHELL_TOOL_NAMES.has(toolName)) {
		const args = parameters as IAgentShellToolArgs | undefined;
		if (args?.command) {
			const firstLine = args.command.split('\n')[0];
			return md(localize('toolInvoke.shellCmd', "Running {0}", appendEscapedMarkdownInlineCode(truncate(firstLine, 80))));
		}
		return localize('toolInvoke.shell', "Running {0} command", displayName);
	}

	if (WRITE_SHELL_TOOL_NAMES.has(toolName)) {
		const args = parameters as IAgentShellToolArgs | undefined;
		if (args?.command) {
			const firstLine = args.command.split('\n')[0];
			return md(localize('toolInvoke.writeShellCmd', "Sending {0} to shell", appendEscapedMarkdownInlineCode(truncate(firstLine, 80))));
		}
		return localize('toolInvoke.writeShell', "Sending input to shell");
	}

	if (READ_SHELL_TOOL_NAMES.has(toolName)) {
		return localize('toolInvoke.readTerminal', "Reading Terminal");
	}

	switch (toolName) {
		case AgentToolName.View: {
			const args = parameters as IAgentViewToolArgs | undefined;
			if (args?.path) {
				const link = formatPathAsMarkdownLink(args.path);
				const range = formatViewRange(args.view_range);
				if (range) {
					if (range.endLine === -1) {
						return md(localize('toolInvoke.viewFileFromLine', "Reading {0}, line {1} to the end", link, range.startLine));
					}
					if (range.endLine !== range.startLine) {
						return md(localize('toolInvoke.viewFileRange', "Reading {0}, lines {1} to {2}", link, range.startLine, range.endLine));
					}
					return md(localize('toolInvoke.viewFileLine', "Reading {0}, line {1}", link, range.startLine));
				}
				return md(localize('toolInvoke.viewFile', "Reading {0}", link));
			}
			return localize('toolInvoke.view', "Reading file");
		}
		case AgentToolName.Edit: {
			const args = parameters as IAgentFileToolArgs | undefined;
			if (args?.path) {
				return md(localize('toolInvoke.editFile', "Editing {0}", formatPathAsMarkdownLink(args.path)));
			}
			return localize('toolInvoke.edit', "Editing file");
		}
		case AgentToolName.Create: {
			const args = parameters as IAgentFileToolArgs | undefined;
			if (args?.path) {
				return md(localize('toolInvoke.createFile', "Creating {0}", formatPathAsMarkdownLink(args.path)));
			}
			return localize('toolInvoke.create', "Creating file");
		}
		case AgentToolName.Grep: {
			const args = parameters as IAgentGrepToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolInvoke.grepPattern', "Searching for {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolInvoke.grep', "Searching files");
		}
		case AgentToolName.Rg: {
			const args = parameters as IAgentRgToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolInvoke.grepPattern', "Searching for {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolInvoke.grep', "Searching files");
		}
		case AgentToolName.Glob: {
			const args = parameters as IAgentGlobToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolInvoke.globPattern', "Finding files matching {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolInvoke.glob', "Finding files");
		}
		case AgentToolName.ApplyPatch:
		case AgentToolName.GitApplyPatch: {
			const files = getEditFilePaths(parameters);
			if (files.length === 1) {
				return md(localize('toolInvoke.patchFile', "Editing {0}", formatPathAsMarkdownLink(files[0])));
			}
			if (files.length > 1) {
				return md(localize('toolInvoke.patchFiles', "Editing {0}", files.map(formatPathAsMarkdownLink).join(', ')));
			}
			return localize('toolInvoke.patch', "Editing files");
		}
		case AgentToolName.Sql: {
			const args = parameters as IAgentSqlToolArgs | undefined;
			return args?.description || localize('toolInvoke.sql', "Executing SQL query");
		}
		case AgentToolName.ExitPlanMode:
			return localize('toolInvoke.exitPlanMode', "Presenting plan");
		default:
			return localize('toolInvoke.generic', "Using \"{0}\"", displayName);
	}
}

export function getPastTenseMessage(toolName: string, displayName: string, parameters: Record<string, unknown> | undefined, success: boolean): StringOrMarkdown {
	if (!success) {
		return localize('toolComplete.failed', "\"{0}\" failed", displayName);
	}

	if (SHELL_TOOL_NAMES.has(toolName)) {
		const args = parameters as IAgentShellToolArgs | undefined;
		if (args?.command) {
			const firstLine = args.command.split('\n')[0];
			return md(localize('toolComplete.shellCmd', "Ran {0}", appendEscapedMarkdownInlineCode(truncate(firstLine, 80))));
		}
		return localize('toolComplete.shell', "Ran {0} command", displayName);
	}

	if (WRITE_SHELL_TOOL_NAMES.has(toolName)) {
		const args = parameters as IAgentShellToolArgs | undefined;
		if (args?.command) {
			const firstLine = args.command.split('\n')[0];
			return md(localize('toolComplete.writeShellCmd', "Sent {0} to shell", appendEscapedMarkdownInlineCode(truncate(firstLine, 80))));
		}
		return localize('toolComplete.writeShell', "Sent input to shell");
	}

	if (READ_SHELL_TOOL_NAMES.has(toolName)) {
		return localize('toolComplete.readTerminal', "Read Terminal");
	}

	switch (toolName) {
		case AgentToolName.View: {
			const args = parameters as IAgentViewToolArgs | undefined;
			if (args?.path) {
				const link = formatPathAsMarkdownLink(args.path);
				const range = formatViewRange(args.view_range);
				if (range) {
					if (range.endLine === -1) {
						return md(localize('toolComplete.viewFileFromLine', "Read {0}, line {1} to the end", link, range.startLine));
					}
					if (range.endLine !== range.startLine) {
						return md(localize('toolComplete.viewFileRange', "Read {0}, lines {1} to {2}", link, range.startLine, range.endLine));
					}
					return md(localize('toolComplete.viewFileLine', "Read {0}, line {1}", link, range.startLine));
				}
				return md(localize('toolComplete.viewFile', "Read {0}", link));
			}
			return localize('toolComplete.view', "Read file");
		}
		case AgentToolName.Edit: {
			const args = parameters as IAgentFileToolArgs | undefined;
			if (args?.path) {
				return md(localize('toolComplete.editFile', "Edited {0}", formatPathAsMarkdownLink(args.path)));
			}
			return localize('toolComplete.edit', "Edited file");
		}
		case AgentToolName.Create: {
			const args = parameters as IAgentFileToolArgs | undefined;
			if (args?.path) {
				return md(localize('toolComplete.createFile', "Created {0}", formatPathAsMarkdownLink(args.path)));
			}
			return localize('toolComplete.create', "Created file");
		}
		case AgentToolName.Grep: {
			const args = parameters as IAgentGrepToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolComplete.grepPattern', "Searched for {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolComplete.grep', "Searched files");
		}
		case AgentToolName.Rg: {
			const args = parameters as IAgentRgToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolComplete.grepPattern', "Searched for {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolComplete.grep', "Searched files");
		}
		case AgentToolName.Glob: {
			const args = parameters as IAgentGlobToolArgs | undefined;
			if (args?.pattern) {
				return md(localize('toolComplete.globPattern', "Found files matching {0}", appendEscapedMarkdownInlineCode(truncate(args.pattern, 80))));
			}
			return localize('toolComplete.glob', "Found files");
		}
		case AgentToolName.ApplyPatch:
		case AgentToolName.GitApplyPatch: {
			const files = getEditFilePaths(parameters);
			if (files.length === 1) {
				return md(localize('toolComplete.patchFile', "Edited {0}", formatPathAsMarkdownLink(files[0])));
			}
			if (files.length > 1) {
				return md(localize('toolComplete.patchFiles', "Edited {0}", files.map(formatPathAsMarkdownLink).join(', ')));
			}
			return localize('toolComplete.patch', "Edited files");
		}
		case AgentToolName.Sql: {
			const args = parameters as IAgentSqlToolArgs | undefined;
			return args?.description || localize('toolComplete.sql', "Executed SQL query");
		}
		case AgentToolName.ExitPlanMode:
			return localize('toolComplete.exitPlanMode', "Exited plan mode");
		default:
			return localize('toolComplete.generic', "Used \"{0}\"", displayName);
	}
}

// =============================================================================
// Skill event synthesis
//
// The Copilot SDK emits a `skill` tool call (which we hide) and, separately, a
// `skill.invoked` lifecycle event with the resolved skill file path. We turn
// the latter into a synthesized tool-start/complete pair so clients can render
// a clickable file link to the SKILL.md the agent loaded -- matching the
// existing `view`-tool display style. Live and replay paths share this helper
// so they stay in lock-step (see also the mirrored-pair gotcha for tool-call
// display in this file).
// =============================================================================

/** Subset of the SDK's `skill.invoked` payload that the synth helper needs. */
export interface IAgentSkillInvokedData {
	readonly name: string;
	readonly path?: string;
	readonly description?: string;
}

/**
 * Builds a stable synthetic tool call id for a `skill.invoked` event so
 * reconnect/replay produces the same id as the original live emit. The id
 * is used unencoded as a path segment (e.g. by `ChatResponseResource.createUri`),
 * so it must not contain characters like `/` -- we hash any fallback values
 * that could carry filesystem paths or arbitrary text.
 */
export function getSkillSyntheticToolCallId(eventId: string | undefined, data: IAgentSkillInvokedData): string {
	if (eventId) {
		return `synth-skill-${eventId}`;
	}
	const seed = data.path ?? data.name;
	return `synth-skill-${hash(seed).toString(16)}`;
}

/**
 * Synthesized data for a `skill.invoked` tool call. Used by both the live
 * session handler and the history-replay mapper so the two paths render
 * identically. Callers wrap this into protocol actions or {@link Turn}
 * data; this helper avoids any agent-protocol coupling.
 */
export interface ISynthesizedSkillToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly displayName: string;
	readonly invocationMessage: StringOrMarkdown;
	readonly pastTenseMessage: StringOrMarkdown;
}

/**
 * Synthesizes the data for a `skill.invoked` tool call (a tool-start /
 * tool-complete pair). Returns the constituent fields without coupling to
 * any specific event or action shape — callers compose them into protocol
 * actions or {@link Turn} entries as needed.
 */
export function synthesizeSkillToolCall(
	data: IAgentSkillInvokedData,
	eventId: string | undefined,
): ISynthesizedSkillToolCall {
	const toolCallId = getSkillSyntheticToolCallId(eventId, data);
	const displayName = localize('toolName.skill', "Read Skill");
	// Use the skill name as the link text rather than the basename: every skill
	// file is named SKILL.md, so `Reading skill [plan]` reads better than the
	// always-identical `Reading skill [SKILL.md]`. The client may further upgrade
	// this link to a rich pill based on the `SKILL.md` basename. Skill names and
	// paths come from the SDK / agent host and are escaped to prevent markdown
	// injection from a malicious skill author.
	// Escape only the characters that would break out of markdown link text
	// syntax (`\` and `]`); a full markdown escape would leave visible
	// backslashes in renderers (like the skill pill) that extract link text
	// without re-parsing markdown.
	const escapedName = escapeMarkdownLinkLabel(data.name);
	const skillLink = data.path ? `[${escapedName}](${URI.file(data.path)})` : undefined;
	const invocationMessage: StringOrMarkdown = skillLink
		? md(localize('toolInvoke.skill', "Reading skill {0}", skillLink))
		: localize('toolInvoke.skillName', "Reading skill {0}", data.name);
	const pastTenseMessage: StringOrMarkdown = skillLink
		? md(localize('toolComplete.skill', "Read skill {0}", skillLink))
		: localize('toolComplete.skillName', "Read skill {0}", data.name);
	return {
		toolCallId,
		toolName: AgentToolName.Skill,
		displayName,
		invocationMessage,
		pastTenseMessage,
	};
}

export function getToolInputString(toolName: string, parameters: Record<string, unknown> | undefined, rawArguments: string | undefined): string | undefined {
	if (!parameters && !rawArguments) {
		return undefined;
	}

	if (SHELL_TOOL_NAMES.has(toolName) || WRITE_SHELL_TOOL_NAMES.has(toolName)) {
		const args = parameters as IAgentShellToolArgs | undefined;
		// Custom tool overrides may wrap the args: { kind: 'custom-tool', args: { command: '...' } }
		const command = args?.command ?? (args as Record<string, unknown> | undefined)?.args;
		if (typeof command === 'string') {
			return command;
		}
		if (typeof command === 'object' && command !== null && hasKey(command, { command: true })) {
			return (command as IAgentShellToolArgs).command;
		}
		return rawArguments;
	}

	switch (toolName) {
		case AgentToolName.Grep: {
			const args = parameters as IAgentGrepToolArgs | undefined;
			return args?.pattern ?? rawArguments;
		}
		case AgentToolName.Rg: {
			const args = parameters as IAgentRgToolArgs | undefined;
			return args?.pattern ?? rawArguments;
		}
		default:
			// For other tools, show the formatted JSON arguments
			if (parameters) {
				try {
					return JSON.stringify(parameters, null, 2);
				} catch {
					return rawArguments;
				}
			}
			return rawArguments;
	}
}

/**
 * Returns a rendering hint for the given tool. Currently 'terminal', 'subagent',
 * and 'search' are supported, which tell the renderer to display the tool with
 * a terminal command block, a subagent widget, or a search icon respectively.
 */
export function getToolKind(toolName: string): 'terminal' | 'subagent' | 'search' | undefined {
	if (SHELL_TOOL_NAMES.has(toolName)) {
		return 'terminal';
	}
	if (SUBAGENT_TOOL_NAMES.has(toolName)) {
		return 'subagent';
	}
	if (SEARCH_TOOL_NAMES.has(toolName)) {
		return 'search';
	}
	return undefined;
}

/**
 * Extracts subagent metadata (agent name, description) from the parsed
 * arguments of a Copilot SDK subagent tool call. The Copilot `task` tool
 * uses `agent_type` (snake_case), which this normalizes into the generic
 * `subagentAgentName` / `subagentDescription` shape used by the rest of the
 * agent host code.
 *
 * Only call this for tools where {@link getToolKind} returned `'subagent'`.
 */
export function getSubagentMetadata(parameters: Record<string, unknown> | undefined): { agentName?: string; description?: string } {
	if (!parameters) {
		return {};
	}
	const agentName = typeof parameters.agent_type === 'string' && parameters.agent_type.length > 0
		? parameters.agent_type
		: undefined;
	const description = typeof parameters.description === 'string' && parameters.description.length > 0
		? parameters.description
		: undefined;
	return { agentName, description };
}

/**
 * Returns the shell language identifier for syntax highlighting.
 * Used when creating terminal tool-specific data for the renderer.
 */
export function getShellLanguage(toolName: string): string {
	switch (toolName) {
		case AgentToolName.PowerShell:
		case AgentToolName.WritePowerShell:
		case AgentToolName.ReadPowerShell: return 'powershell';
		default: return 'shellscript';
	}
}

// =============================================================================
// Permission display
//
// Derives display fields from SDK permission requests for the tool
// confirmation UI. Colocated with the tool-start display helpers above so
// that formatting utilities (formatPathAsMarkdownLink, md, etc.) are shared.
// =============================================================================

export function tryStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/**
 * Extends the SDK's {@link PermissionRequest} with the known extra properties
 * that arrive on the index-signature. The SDK defines these as `[key: string]: unknown`
 * so this interface adds proper types for the fields we actually use.
 */
export interface ITypedPermissionRequest extends PermissionRequest {
	/** File path — set for `read` permission requests. */
	path?: string;
	/** File path — set for `write` permission requests. */
	fileName?: string;
	/** Full shell command text — set for `shell` permission requests. */
	fullCommandText?: string;
	/** Human-readable intention describing the operation. */
	intention?: string;
	/** MCP server name — set for `mcp` permission requests. */
	serverName?: string;
	/** Tool name — set for `mcp` and `custom-tool` permission requests. */
	toolName?: string;
	/** Tool arguments — set for `custom-tool` permission requests. */
	args?: Record<string, unknown>;
	/** URL — set for `url` permission requests. */
	url?: string;
	/** Unified diff of the proposed change — set for `write` permission requests. */
	diff?: string;
	/** New file contents that will be written — set for `write` permission requests. */
	newFileContents?: string;
}

/** Safely extract a string value from an SDK field that may be `unknown` at runtime. */
function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * Derives display fields from a permission request for the tool confirmation UI.
 */
export function getPermissionDisplay(request: ITypedPermissionRequest, workingDirectory?: URI): {
	confirmationTitle: string;
	invocationMessage: StringOrMarkdown;
	toolInput?: string;
	/** Normalized permission kind for auto-approval routing. */
	permissionKind: IAgentToolPendingConfirmationSignal['permissionKind'];
	/** File path extracted from the request. */
	permissionPath?: string;
} {
	const path = str(request.path) ?? str(request.fileName);
	const fullCommandText = str(request.fullCommandText);
	const intention = str(request.intention);
	const serverName = str(request.serverName);
	const toolName = str(request.toolName);

	switch (request.kind) {
		case 'shell': {
			// Strip a redundant `cd <workingDirectory> && …` prefix so the
			// confirmation dialog shows the simplified command.
			const shellParams: Record<string, unknown> | undefined = fullCommandText ? { command: fullCommandText } : undefined;
			stripRedundantCdPrefix(AgentToolName.Bash, shellParams, workingDirectory);
			const cleanedCommand = typeof shellParams?.command === 'string' ? shellParams.command : fullCommandText;
			return {
				confirmationTitle: localize('aiStudio.permission.shell.title', "Run in terminal?"),
				invocationMessage: intention ?? getInvocationMessage(AgentToolName.Bash, getToolDisplayName(AgentToolName.Bash), cleanedCommand ? { command: cleanedCommand } : undefined),
				toolInput: cleanedCommand,
				permissionKind: 'shell',
				permissionPath: path,
			};
		}
		case 'custom-tool': {
			// Custom tool overrides (e.g. our shell tool). Extract the actual
			// tool args from the SDK's wrapper envelope.
			const args = typeof request.args === 'object' && request.args !== null ? request.args as Record<string, unknown> : undefined;
			const sdkToolName = str(request.toolName);
			if (args && sdkToolName && isShellTool(sdkToolName) && typeof args.command === 'string') {
				stripRedundantCdPrefix(sdkToolName, args, workingDirectory);
				const command = args.command as string;
				return {
					confirmationTitle: localize('aiStudio.permission.shell.title', "Run in terminal?"),
					invocationMessage: getInvocationMessage(sdkToolName, getToolDisplayName(sdkToolName), { command }),
					toolInput: command,
					permissionKind: 'shell',
					permissionPath: path,
				};
			}
			return {
				confirmationTitle: localize('aiStudio.permission.default.title', "Allow tool call?"),
				invocationMessage: md(localize('aiStudio.permission.default.message', "Allow the model to call {0}?", appendEscapedMarkdownInlineCode(toolName ?? request.kind))),
				toolInput: args ? tryStringify(args) : tryStringify(request),
				permissionKind: request.kind,
				permissionPath: path,
			};
		}
		case 'write':
			return {
				confirmationTitle: localize('aiStudio.permission.write.title', "Write file?"),
				invocationMessage: getInvocationMessage(AgentToolName.Edit, getToolDisplayName(AgentToolName.Edit), path ? { path } : undefined),
				toolInput: tryStringify(path ? { path } : request) ?? undefined,
				permissionKind: 'write',
				permissionPath: path,
			};
		case 'mcp': {
			const title = toolName ?? localize('aiStudio.permission.mcp.defaultTool', "MCP Tool");
			return {
				confirmationTitle: serverName
					? localize('aiStudio.permission.mcp.title', "Allow tool from {0}?", serverName)
					: localize('aiStudio.permission.default.title', "Allow tool call?"),
				invocationMessage: serverName ? `${serverName}: ${title}` : title,
				toolInput: tryStringify({ serverName, toolName }) ?? undefined,
				permissionKind: 'mcp',
				permissionPath: path,
			};
		}
		case 'read':
			return {
				confirmationTitle: localize('aiStudio.permission.read.title', "Read file?"),
				invocationMessage: intention ?? getInvocationMessage(AgentToolName.View, getToolDisplayName(AgentToolName.View), path ? { path } : undefined),
				toolInput: tryStringify(path ? { path, intention } : request) ?? undefined,
				permissionKind: 'read',
				permissionPath: path,
			};
		case 'url': {
			const url = str(request.url);
			// Parse through URL for punycode escaping, but preserve the raw value if parsing fails.
			const normalizedUrl = url ? (URL.canParse(url) ? new URL(url).href : url) : undefined;
			return {
				confirmationTitle: localize('aiStudio.permission.url.title', "Fetch URL?"),
				invocationMessage: md(localize('aiStudio.permission.url.message', "Allow fetching web content?")),
				toolInput: normalizedUrl ? JSON.stringify({ url: normalizedUrl }) : undefined,
				permissionKind: 'url',
			};
		}
		default:
			return {
				confirmationTitle: localize('aiStudio.permission.default.title', "Allow tool call?"),
				invocationMessage: md(localize('aiStudio.permission.default.message', "Allow the model to call {0}?", appendEscapedMarkdownInlineCode(toolName ?? request.kind))),
				toolInput: tryStringify(request) ?? undefined,
				permissionKind: request.kind,
				permissionPath: path,
			};
	}
}
