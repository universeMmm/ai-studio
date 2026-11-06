/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — OpenAI / Custom Provider
 *  Uses native fetch() to call any OpenAI-compatible API — no npm SDK needed.
 *--------------------------------------------------------------------------------------------*/

import { decodeToolArguments } from './toolRuntime.js';
import { providerEvents } from './providerEvents.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { IAIProvider } from './aiProvider.js';
import type {
	AIMessage, AIMessageContent, StopReason, AITool, AIRequestOptions, AIStreamCallbacks,
	AICompletionOptions, AICompletionCallbacks, FileContext, AIModel,
} from './aiTypes.js';
import { withSystemPrompt, COMPLETION_SYSTEM_PROMPT } from './systemPrompt.js';

export class CustomProvider extends Disposable implements IAIProvider {
	declare readonly _serviceBrand: undefined;
	readonly id = 'openai';
	readonly label = 'OpenAI';

	constructor(
		private readonly apiBase: string,
		private readonly apiKey: string,
		private readonly modelId: string,
		@ILogService private readonly logService: ILogService,
	) { super(); }

	// ── Streaming Chat ───────────────────────────────────────

	streamChat(messages: AIMessage[], tools: AITool[], options: AIRequestOptions, callbacks: AIStreamCallbacks): AbortController {
		const ctl = new AbortController();
		this._streamChat(messages, tools, options, callbacks, ctl.signal);
		return ctl;
	}

	private async _streamChat(messages: AIMessage[], tools: AITool[], options: AIRequestOptions, callbacks: AIStreamCallbacks, signal: AbortSignal): Promise<void> {
		try {
			const body: Record<string, unknown> = {
				model: this.modelId,
				max_tokens: options.maxTokens || 16000,
				temperature: options.temperature ?? 0,
				messages: this._convertMessages(withSystemPrompt(messages)),
				stream_options: { include_usage: true },
				stream: true,
			};
			if (tools.length) { body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })); }

			let res: Response;
			try {
				res = await this._fetch('/chat/completions', body, signal);
			} catch (err) {
				// Some compatible endpoints explicitly reject this optional OpenAI field.
				if (!(err instanceof Error && /^API (400|422):/i.test(err.message) && /stream_options|include_usage/i.test(err.message))) {
					throw err;
				}
				delete body.stream_options;
				res = await this._fetch('/chat/completions', body, signal);
			}
			const calls = new Map<number, { id: string; name: string; args: string }>();
			let reason: StopReason = 'end_turn';
			let finished = false;
			for await (const data of providerEvents(res)) {
				if (data.trim() === '[DONE]') { finished = true; break; }
				const event = JSON.parse(data);
				if (event.error) { throw new Error(event.error.message || 'Model stream error'); }
				if (event.usage) { callbacks.onUsage?.({ inputTokens: event.usage.prompt_tokens ?? 0, outputTokens: event.usage.completion_tokens ?? 0 }); }
				const choice = event.choices?.[0];
				if (choice?.delta?.content) { callbacks.onToken(choice.delta.content); }
				for (const fragment of choice?.delta?.tool_calls ?? []) {
					const index = fragment.index ?? 0;
					const call = calls.get(index) ?? { id: '', name: '', args: '' };
					if (fragment.id) { call.id = fragment.id; }
					call.name += fragment.function?.name ?? '';
					call.args += fragment.function?.arguments ?? '';
					calls.set(index, call);
				}
				if (choice?.finish_reason) {
					finished = true;
					if (choice.finish_reason === 'length') { reason = 'max_tokens'; }
				}
			}
			if (calls.size && (!finished || reason === 'max_tokens')) { throw new Error('Incomplete model tool call batch'); }
			for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
				const { input, error } = decodeToolArguments(call.args);
				callbacks.onToolUse(call.name, input, call.id, error);
			}
			callbacks.onDone(calls.size ? 'tool_use' : reason);
		} catch (err: unknown) { if (!(err instanceof Error && err.name === 'AbortError')) { this.logService.error('[CustomProvider]', err); callbacks.onError(err instanceof Error ? err : new Error(String(err))); } }
	}

	// ── Streaming Completion ─────────────────────────────────

	streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		const ctl = new AbortController();
		this._streamCompletion(prefix, suffix, fc, options, callbacks, ctl.signal);
		return ctl;
	}

	private async _streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks, signal: AbortSignal): Promise<void> {
		try {
			const body = { model: this.modelId, max_tokens: options.maxTokens || 4096, temperature: options.temperature ?? 0, messages: [{ role: 'system', content: COMPLETION_SYSTEM_PROMPT(fc.languageId, fc.filePath) }, { role: 'user', content: `<code_before>\n${prefix}\n</code_before>\n<code_after>\n${suffix}\n</code_after>` }], stream: true };
			const res = await this._fetch('/chat/completions', body, signal);
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '', full = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) { continue; }
					const data = line.slice(6).trim();
					if (data === '[DONE]') { callbacks.onDone(full); return; }
					try { const t = JSON.parse(data).choices?.[0]?.delta?.content; if (t) { full += t; callbacks.onToken(t); } } catch {
						buffer = line + '\n' + buffer;
					}
				}
			}
			callbacks.onDone(full);
		} catch (err: unknown) { if (!(err instanceof Error && err.name === 'AbortError')) { callbacks.onError(err instanceof Error ? err : new Error(String(err))); } }
	}

	// ── Embeddings + Models ──────────────────────────────────

	async embed(texts: string[]): Promise<number[][]> {
		const res = await this._fetch('/embeddings', { model: 'text-embedding-3-small', input: texts }, new AbortController().signal);
		const json: { data?: { embedding: number[] }[] } = await res.json();
		if (!json.data?.length) { throw new Error('Empty embedding response'); }
		return json.data.map(d => d.embedding);
	}

	async listModels(): Promise<AIModel[]> {
		return [
			{ id: 'gpt-5', name: 'GPT-5', maxTokens: 128000, supportsThinking: true, supportsPromptCaching: false },
			{ id: 'gpt-4o', name: 'GPT-4o', maxTokens: 128000, supportsThinking: false, supportsPromptCaching: false },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
		];
	}

	// ── Helpers ──────────────────────────────────────────────

	private async _fetch(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
		const url = (this.apiBase.endsWith('/') ? this.apiBase.slice(0, -1) : this.apiBase) + path;
		const res = await fetch(url, {
			method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey, 'HTTP-Referer': 'ai-studio', 'X-Title': 'AI Studio' }, body: JSON.stringify(body), signal,
		});
		if (!res.ok) { const text = await res.text(); throw new Error(`API ${res.status}: ${text.slice(0, 500)}`); }
		return res;
	}

	private _convertMessages(messages: AIMessage[]): unknown[] {
		const result: unknown[] = [];
		let pendingImages: ReturnType<typeof imagePart>[] = [];
		const flushImages = () => {
			if (pendingImages.length) {
				result.push({ role: 'user', content: pendingImages });
				pendingImages = [];
			}
		};
		for (const msg of messages) {
			if (msg.role !== 'tool') {
				flushImages();
			}
			if (typeof msg.content === 'string') {
				result.push({ role: msg.role, content: msg.content, ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}) });
				continue;
			}
			if (msg.role === 'tool') {
				const results = msg.content.filter(block => block.type === 'tool_result');
				if (!results.length) {
					results.push({ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content });
				}
				for (const block of results) {
					const parts = block.content;
					let text = '';
					if (typeof parts === 'string') {
						text = parts;
					} else if (parts) {
						for (const part of parts) {
							if (part.type === 'text') { text += part.text ?? ''; }
							if (part.type === 'image' && part.source) { pendingImages.push(imagePart(part.source)); }
						}
					}
					// Chat Completions accepts images on user messages, while tool messages carry text and the call ID.
					result.push({ role: 'tool', tool_call_id: block.tool_use_id ?? msg.toolCallId, content: text });
				}
				continue;
			}
			const toolCalls = msg.content.filter(block => block.type === 'tool_use').map(block => ({
				id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
			}));
			const parts: ({ type: 'text'; text: string } | ReturnType<typeof imagePart>)[] = [];
			for (const block of msg.content) {
				if (block.type === 'text') { parts.push({ type: 'text', text: block.text ?? '' }); }
				if (block.type === 'image' && block.source) { parts.push(imagePart(block.source)); }
			}
			const content = parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
			result.push({ role: msg.role, content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
		}
		flushImages();
		return result;
	}
}

function imagePart(source: NonNullable<AIMessageContent['source']>) {
	return { type: 'image_url' as const, image_url: { url: `data:${source.media_type};base64,${source.data}` } };
}
