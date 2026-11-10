/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Core Type Definitions
 *  All AI platform types in one place for consistent use across all modules.
 *--------------------------------------------------------------------------------------------*/

import type { AIReasoningEffort } from './aiReasoning.js';

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
	content?: string | AIMessageContent[];
	is_error?: boolean;
	/** Image source data for Anthropic Messages API image content blocks. */
	source?: {
		type: 'base64';
		media_type: string;
		data: string;
	};
}

/**
 * A single message in a conversation.
 */
export interface AIMessage {
	role: AIMessageRole;
	content: string | AIMessageContent[];
	/** Provider reasoning required for tool-call continuation; never render it as answer text. */
	reasoningContent?: string;
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
		properties: Record<string, ToolInputProperty>;
		required: string[];
	};
}

export interface ToolInputProperty {
	type: string;
	description?: string;
	enum?: string[];
	default?: unknown;
	items?: ToolInputProperty;
	properties?: Record<string, ToolInputProperty>;
	required?: string[];
}

/**
 * Options for a streaming chat request.
 */
export interface AIRequestOptions {
	model: string;
	maxTokens: number;
	temperature: number;
	thinking: boolean;
	reasoningEffort?: AIReasoningEffort;
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
	/** A reasoning fragment retained for provider protocol continuity, separate from visible output. */
	onReasoning?(token: string): void;
	onToolUse(toolName: string, toolInput: Record<string, unknown>, toolCallId: string, inputError?: string): void;
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

/** Task status */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** A single task in the agent's task list */
export interface Task {
	readonly id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

/**
 * A single conversation turn (user/assistant pair).
 * Duplicated from conversationMemory.ts to avoid circular imports.
 */
export interface ConversationTurn {
	userMessage: string;
	assistantMessage: string;
	/** Stable native-chat identity; source text excludes attachment augmentation. */
	requestId?: string;
	sourceUserMessage?: string;
	/** Hidden provider continuation data; not part of the displayed assistant message. */
	reasoningContent?: string;
	timestamp: number;
}

/** Complete session data for persistence. */
export interface AgentSession {
	/** Native workbench chat URI; older standalone runs have no chat association. */
	chatSessionId?: string;
	/** ISO timestamp when the session was created */
	sessionId: string;
	/** When the session started (epoch ms) */
	startedAt: number;
	/** When the session ended (epoch ms) */
	endedAt: number;
	/** The original user instruction */
	instruction: string;
	/** All execution steps (thoughts, tool calls, results, errors) */
	steps: AgentStep[];
	/** Task snapshot captured at session end */
	taskSnapshot: readonly Task[] | null;
	/** User/assistant message pairs (backward-compatible with existing format) */
	turns: ConversationTurn[];
	/** Final agent status */
	status: AgentStatus;
	/** Token usage totals */
	usage: { inputTokens: number; outputTokens: number } | null;
	/** Model and config used */
	meta: {
		modelId: string;
		maxSteps: number;
		maxTokens: number;
	};
}

export interface AgentStep {
	stepNumber: number;
	type: 'thought' | 'tool_use' | 'tool_result' | 'error' | 'plan';
	content: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	outcome?: 'success' | 'error' | 'denied' | 'cancelled';
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
	WebFetch = 'web_fetch',
	WebSearch = 'web_search',
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
	enabled: boolean;
	state: 'disabled' | 'idle' | 'indexing' | 'cancelled' | 'error';
	processed: number;
	total: number;
	limited: boolean;
	memoryBytes: number;
	memoryLimitBytes: number;
	memoryLimited: boolean;
}

/**
 * Status of a diff edit.
 */
export type DiffEditStatus = 'applied' | 'accepted' | 'rejected';

/**
 * A single diff hunk describing one code change.
 */
export interface DiffHunk {
	id: string;
	filePath: string;
	originalStartLine: number;
	originalEndLine: number;
	modifiedStartLine: number;
	modifiedStartColumn?: number;
	kind?: 'edit' | 'write' | 'create';
	/** Neighbouring text bounds the recorded edit when later changes shift the file. */
	beforeAnchor?: string;
	afterAnchor?: string;
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
	sessionId?: string;
	hunks: DiffHunk[];
	createdAt: number;
}

/**
 * Sub-agent type determines available tools.
 */
export type SubAgentType = 'general-purpose' | 'Explore' | 'Plan' | 'verification';

/**
 * Configuration for spawning a sub-agent.
 */
export interface SubAgentConfig {
	subagent_type: SubAgentType;
	description: string;
	prompt?: string;
	name?: string;
	run_in_background: boolean;
	mode: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'auto';
	cwd?: string;
	isolation?: 'worktree';
}

/**
 * Result from a completed sub-agent.
 */
export interface SubAgentResult {
	name: string;
	status: 'completed' | 'error' | 'aborted';
	text: string;
	error?: string;
	toolCalls: number;
	usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Input for the AskUserQuestion tool.
 */
export interface AskUserQuestionInput {
	question: string;
	header?: string;
	options: { label: string; description: string }[];
	multiSelect?: boolean;
}

/**
 * Memory type.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * Parsed user memory entry from ~/.ai-studio/memory/.
 */
export interface MemoryEntry {
	name: string;
	description: string;
	type: MemoryType;
	content: string;
}
