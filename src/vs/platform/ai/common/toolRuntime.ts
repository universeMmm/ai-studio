/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Streamed tool calls and per-turn execution policy.
 *--------------------------------------------------------------------------------------------*/

import type { IAIProvider } from './aiProvider.js';
import type { AIMessage, AIMessageContent, AIRequestOptions, AITool, StopReason, ToolInputProperty } from './aiTypes.js';
import { ExpectedError } from '../../../base/common/errors.js';

export type ToolOutcome = 'success' | 'error' | 'denied' | 'cancelled';
export type CommandApprovalHandler = (command: string, cwd: string, signal?: AbortSignal) => Promise<boolean>;

export interface AgentToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	inputError?: string;
}

export interface AgentTurn {
	text: string;
	reasoningContent?: string;
	calls: AgentToolCall[];
	stopReason?: StopReason;
}

/** A provider ended the generation without completing the requested turn. Retrying the same budget cannot fix it. */
export class ModelTurnError extends ExpectedError {
	constructor(readonly stopReason: StopReason, message: string) {
		super(message);
		this.name = 'ModelTurnError';
	}
}

export const parallelReadTools: ReadonlySet<string> = new Set([
	'read_file', 'search_content', 'search_files', 'search_pattern', 'list_directory', 'read_lints', 'web_fetch', 'web_search',
	'TaskGet', 'TaskList', 'LocalMemoryRecall',
]);

export function allowedInPlan(name: string): boolean {
	return parallelReadTools.has(name) || name === 'AskUserQuestion' || name === 'ExitPlanMode';
}

export function collectAgentTurn(
	model: Pick<IAIProvider, 'streamChat'>, messages: AIMessage[], tools: AITool[], options: AIRequestOptions,
	signal: AbortSignal, onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): Promise<AgentTurn> {
	return new Promise<AgentTurn>((resolve, reject) => {
		signal.throwIfAborted();
		let text = '';
		let reasoningContent: string | undefined;
		const calls: AgentToolCall[] = [];
		let usage: { inputTokens: number; outputTokens: number } | undefined;
		let request: AbortController | undefined;
		let settled = false;
		const cancel = () => { request?.abort(); fail(signal.reason); };
		const finish = () => { settled = true; signal.removeEventListener('abort', cancel); if (usage) { onUsage?.(usage); } };
		const fail = (error: unknown) => { if (!settled) { finish(); reject(error); } };
		signal.addEventListener('abort', cancel, { once: true });
		try {
			request = model.streamChat(messages, tools, options, {
				onToken: token => { if (!settled) { text += token; } },
				onReasoning: token => { if (!settled) { reasoningContent = (reasoningContent ?? '') + token; } },
				onToolUse: (name, input, id, inputError) => { if (!settled) { calls.push({ name, input, id, inputError }); } },
				onToolResult() { },
				onError: fail,
				onUsage: value => { usage = value; },
				onDone: reason => {
					if (settled) { return; }
					if (signal.aborted) { fail(signal.reason); return; }
					if (reason === 'error' || reason === 'aborted') { fail(new ModelTurnError(reason, 'Provider ended the request: ' + reason)); return; }
					if (reason === 'max_tokens') {
						fail(new ModelTurnError(reason, '模型回复达到输出上限，任务尚未完成。请提高回复词元上限或缩小任务后重试。'));
						return;
					}
					if ((reason === 'tool_use' && !calls.length)
						|| calls.some(call => !call.id || !call.name) || new Set(calls.map(call => call.id)).size !== calls.length) {
						fail(new Error('Invalid or incomplete tool call batch from the model.'));
						return;
					}
					finish();
					resolve({ text, calls, stopReason: reason, ...(reasoningContent !== undefined ? { reasoningContent } : {}) });
				},
			});
			if (signal.aborted) { request.abort(); }
		} catch (error) { fail(error); }
	});
}

export function assistantToolMessage(turn: AgentTurn): AIMessage {
	const content: AIMessageContent[] = turn.text ? [{ type: 'text', text: turn.text }] : [];
	for (const { id, name, input } of turn.calls) {
		content.push({ type: 'tool_use', id, name, input });
	}
	return { role: 'assistant', content, ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}) };
}

// Only consecutive read-only calls may overlap. Every other call is a barrier, including unknown tools.
export async function executeToolBatch(
	calls: AgentToolCall[], execute: (call: AgentToolCall) => Promise<AIMessageContent>, signal: AbortSignal,
): Promise<AIMessageContent[]> {
	const results: AIMessageContent[] = [];
	for (let i = 0; i < calls.length;) {
		signal.throwIfAborted();
		const start = i++;
		if (parallelReadTools.has(calls[start].name)) {
			while (i < calls.length && i - start < 4 && parallelReadTools.has(calls[i].name)) { i++; }
		}
		const group = await Promise.allSettled(calls.slice(start, i).map(execute));
		signal.throwIfAborted();
		for (const result of group) {
			if (result.status === 'rejected') { throw result.reason; }
			results.push(result.value);
		}
	}
	return results;
}

export function toolResult(id: string, text: string, outcome: ToolOutcome, images: AIMessageContent[] = []): AIMessageContent {
	return {
		type: 'tool_result', tool_use_id: id,
		is_error: outcome !== 'success',
		content: images.length ? [{ type: 'text', text }, ...images] : outcome === 'success' ? text : '[' + outcome + '] ' + text,
	};
}

export function decodeToolArguments(raw: string): { input: Record<string, unknown>; error?: string } {
	try {
		const value = JSON.parse(raw || '{}');
		if (value && typeof value === 'object' && !Array.isArray(value)) { return { input: value }; }
	} catch { /* Give the caller a correlated error result so it can correct the arguments. */ }
	return { input: {}, error: 'Tool arguments must be a complete JSON object.' };
}

export function validateToolCall(call: AgentToolCall, tool: AITool): string | undefined {
	return call.inputError ?? validateValue(call.input, tool.input_schema, call.name);
}

function validateValue(value: unknown, spec: ToolInputProperty, path: string): string | undefined {
	const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
	if (type !== spec.type) { return 'Invalid type for ' + path + ': expected ' + spec.type; }
	if (spec.enum && !spec.enum.includes(value as string)) { return 'Unsupported value for ' + path; }
	if (Array.isArray(value) && spec.items) {
		for (let i = 0; i < value.length; i++) {
			const invalid = validateValue(value[i], spec.items, path + '[' + i + ']');
			if (invalid) { return invalid; }
		}
	}
	if (type === 'object' && spec.properties) {
		const object = value as Record<string, unknown>;
		for (const key of spec.required ?? []) {
			if (!Object.hasOwn(object, key)) { return 'Missing required argument: ' + path + '.' + key; }
		}
		for (const [key, child] of Object.entries(spec.properties)) {
			if (Object.hasOwn(object, key)) {
				const invalid = validateValue(object[key], child, path + '.' + key);
				if (invalid) { return invalid; }
			}
		}
	}
	return undefined;
}
