/*---------------------------------------------------------------------------------------------
 *  AI Studio — Core Type Definitions
 *  All AI platform types in one place for consistent use across all modules.
 *--------------------------------------------------------------------------------------------*/

/**
 * Supported LLM provider identifiers.
 */
export type AIProviderId = 'openai' | 'anthropic';

/**
 * Message roles in a chat conversation.
 */
export type AIMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Structured content blocks within a message (for tool use / results).
 */
export interface AIMessageContent {
	type: 'text' | 'tool_use' | 'tool_result' | 'image';
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | Array<{ type: string; text?: string }>;
	is_error?: boolean;
}

/**
 * A single message in a conversation.
 */
export interface AIMessage {
	role: AIMessageRole;
	content: string | AIMessageContent[];
	toolCallId?: string;
	name?: string;
}

/**
 * Tool definition following the JSON Schema / Anthropic tool-use convention.
 */
export interface AITool {
	name: string;
	description: string;
	input_schema: {
		type: 'object';
		properties: Record<string, {
			type: string;
			description: string;
			enum?: string[];
			default?: unknown;
		}>;
		required: string[];
	};
}

/**
 * Options for a streaming chat request.
 */
export interface AIRequestOptions {
	model: string;
	maxTokens: number;
	temperature: number;
	thinking: boolean;
	cacheSystemPrompt: boolean;
	maxContextTokens: number;
}

/**
 * Reasons a stream may stop.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'error' | 'aborted';

/**
 * Callbacks for streaming chat responses.
 */
export interface AIStreamCallbacks {
	onToken(token: string): void;
	onToolUse(toolName: string, toolInput: Record<string, unknown>, toolCallId: string): void;
	onToolResult(toolCallId: string, result: string, isError: boolean): void;
	onError(error: Error): void;
	onDone(stopReason: StopReason): void;
	onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
}

/**
 * Options for inline code completion.
 */
export interface AICompletionOptions {
	maxTokens: number;
	temperature: number;
	stopSequences: string[];
}

/**
 * Callbacks for code completion.
 */
export interface AICompletionCallbacks {
	onToken(token: string): void;
	onDone(fullText: string): void;
	onError(error: Error): void;
}

/**
 * Context of the file being edited, sent with completion requests.
 */
export interface FileContext {
	filePath: string;
	languageId: string;
	content: string;
	cursorLine: number;
	cursorColumn: number;
}

/**
 * Metadata about an available model.
 */
export interface AIModel {
	id: string;
	name: string;
	maxTokens: number;
	supportsThinking: boolean;
	supportsPromptCaching: boolean;
}

/**
 * A code snippet returned from search or index.
 */
export interface CodeSnippet {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
	score: number;
}

/**
 * A single step in an agent execution trace.
 */

/** A single step in the agent execution plan. */
export interface PlanStep {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	expectedTool?: BuiltInToolName;
	status: PlanStepStatus;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed";

/** Structured execution plan generated before the agent loop. */
export interface AgentPlan {
	readonly steps: PlanStep[];
	currentStepIndex: number;
}

export interface AgentStep {
	stepNumber: number;
	type: 'thought' | 'tool_use' | 'tool_result' | 'error' | 'plan';
	content: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	timestamp: number;
}

/**
 * Agent lifecycle states.
 */
export type AgentStatus = 'idle' | 'running' | 'waiting_for_approval' | 'stopped' | 'error';

/**
 * Built-in tool identifiers.
 */
export enum BuiltInToolName {
	ReadFile = 'read_file',
	WriteFile = 'write_file',
	EditFile = 'edit_file',
	SearchContent = 'search_content',
	SearchFiles = 'search_files',
	RunCommand = 'run_command',
	ListDirectory = 'list_directory',
	ReadLints = 'read_lints',
	SearchPattern = 'search_pattern',
}

/**
 * A chunk of code produced by the chunker for indexing.
 */
export interface ChunkedCode {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
	kind: 'function' | 'class' | 'method' | 'module' | 'other';
	name: string;
}

/**
 * Statistics about the code index.
 */
export interface IndexStats {
	totalFiles: number;
	totalChunks: number;
	lastIndexedAt: number;
	isReady: boolean;
}

/**
 * Status of a diff edit.
 */
export type DiffEditStatus = 'applied' | 'rejected';

/**
 * A single diff hunk describing one code change.
 */
export interface DiffHunk {
	id: string;
	filePath: string;
	originalStartLine: number;
	originalEndLine: number;
	modifiedStartLine: number;
	modifiedEndLine: number;
	originalText: string;
	modifiedText: string;
	status: DiffEditStatus;
}

/**
 * A group of diff hunks belonging to one AI message.
 */
export interface DiffGroup {
	id: string;
	chatMessageId: string;
	hunks: DiffHunk[];
	createdAt: number;
}
