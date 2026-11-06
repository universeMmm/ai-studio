/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Anthropic Provider
 *  Uses native fetch() to call Anthropic Messages API.
 *--------------------------------------------------------------------------------------------*/

import { decodeToolArguments, ModelTurnError } from './toolRuntime.js';
import { providerEvents } from './providerEvents.js';
import { applyAnthropicEffort } from './aiReasoning.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { IAIProvider } from './aiProvider.js';
import type {
	AIMessage, AITool, AIRequestOptions, AIStreamCallbacks, StopReason,
	AICompletionOptions, AICompletionCallbacks, FileContext, AIModel,
} from './aiTypes.js';
import { withSystemPrompt, COMPLETION_SYSTEM_PROMPT } from './systemPrompt.js';

export class AnthropicProvider extends Disposable implements IAIProvider {
	declare readonly _serviceBrand: undefined;
	readonly id = 'anthropic';
	readonly label = 'Anthropic';

	constructor(
		private readonly apiKey: string,
		private readonly modelId: string,
		private readonly apiBase: string | undefined,
		@ILogService private readonly logService: ILogService,
	) { super(); }

	private get _baseUrl() { return (this.apiBase || 'https://api.anthropic.com').replace(/\/$/, ''); }

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
				system: withSystemPrompt(messages).filter(msg => msg.role === 'system').flatMap(msg =>
					typeof msg.content === 'string' ? [{ type: 'text' as const, text: msg.content }] : msg.content.filter(block => block.type === 'text')),
				messages: this._convertMessages(messages),
				stream: true,
				thinking: options.thinking ? { type: 'enabled' } : { type: 'disabled' },
			};
			if (options.thinking && this._baseUrl.includes('deepseek')) { body.reasoning_effort = 'high'; }
			applyAnthropicEffort(body, this.modelId, this._baseUrl, options.reasoningEffort);
			if (tools.length) { body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })); }

			const url = this._baseUrl + '/v1/messages';
			this.logService.info('[Anthropic] POST ' + url + ' model=' + this.modelId);

			const res = await fetch(url, {
				// x-api-key is not stripped by fetch on cross-origin redirects.
				method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', ...(options.cacheSystemPrompt !== false ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}) }, body: JSON.stringify(body), signal,
			});
			if (!res.ok) { const t = await res.text(); throw new Error('Anthropic ' + res.status + ': ' + t.slice(0, 500)); }

			const calls = new Map<number, { id: string; name: string; initial: unknown; args: string; complete: boolean }>();
			let inputTokens = 0, outputTokens = 0;
			let finished = false;
			let reason: StopReason = 'end_turn';
			for await (const data of providerEvents(res)) {
				const event = JSON.parse(data);
				const index = event.index ?? 0;
				const usage = event.message?.usage ?? event.usage;
				if (usage) {
					inputTokens = usage.input_tokens ?? inputTokens;
					outputTokens = usage.output_tokens ?? outputTokens;
					callbacks.onUsage?.({ inputTokens, outputTokens });
				}
				switch (event.type) {
					case 'error': throw new Error(event.error?.message || 'Model stream error');
					case 'content_block_start':
						if (event.content_block?.type === 'tool_use') {
							const { id, name, input } = event.content_block;
							calls.set(index, { id, name, initial: input, args: '', complete: false });
						}
						break;
					case 'content_block_delta': {
						const call = calls.get(index);
						if (event.delta?.type === 'text_delta') { callbacks.onToken(event.delta.text); }
						if (call && event.delta?.type === 'input_json_delta') { call.args += event.delta.partial_json; }
						break;
					}
					case 'content_block_stop': {
						const call = calls.get(index);
						if (call) { call.complete = true; }
						break;
					}
					case 'message_delta':
						if (event.delta?.stop_reason) {
							switch (event.delta.stop_reason) {
								case 'end_turn': case 'stop_sequence': case 'tool_use': case 'max_tokens': reason = event.delta.stop_reason; break;
								default: throw new ModelTurnError('error', 'Model generation did not complete: ' + String(event.delta.stop_reason));
							}
						}
						break;
					case 'message_stop': finished = true; break;
				}
				if (finished) { break; }
			}
			signal.throwIfAborted();
			if (!finished) { throw new Error('Incomplete model stream: missing message_stop event.'); }
			if (calls.size && reason === 'max_tokens') { throw new ModelTurnError('max_tokens', 'Incomplete model tool call batch: output token limit reached.'); }
			if (calls.size && [...calls.values()].some(call => !call.complete)) {
				throw new Error('Incomplete model tool call batch');
			}
			for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
				const { input, error } = decodeToolArguments(call.args || JSON.stringify(call.initial ?? {}));
				callbacks.onToolUse(call.name, input, call.id, error);
			}
			callbacks.onDone(reason === 'max_tokens' ? reason : calls.size ? 'tool_use' : reason);
		} catch (err: unknown) { if (!(err instanceof Error && err.name === 'AbortError')) { this.logService.error('[Anthropic]', err); callbacks.onError(err instanceof Error ? err : new Error(String(err))); } }
	}

	streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		const ctl = new AbortController();
		this._streamCompletion(prefix, suffix, fc, options, callbacks, ctl.signal);
		return ctl;
	}

	private async _streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks, signal: AbortSignal): Promise<void> {
		try {
			const body = { model: this.modelId, max_tokens: options.maxTokens || 4096, temperature: options.temperature ?? 0, system: COMPLETION_SYSTEM_PROMPT(fc.languageId, fc.filePath), messages: [{ role: 'user', content: '<code_before>\n' + prefix + '\n</code_before>\n<code_after>\n' + suffix + '\n</code_after>' }], stream: true };
			const res = await fetch(this._baseUrl + '/v1/messages', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
			const reader = res.body!.getReader(); const d = new TextDecoder(); let buf = '', full = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buf += d.decode(value, { stream: true });

				const lines = buf.split('\n');
				buf = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) { continue; }
					try {
						const e = JSON.parse(line.slice(6).trim());
						if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { full += e.delta.text; callbacks.onToken(e.delta.text); }
						if (e.type === 'message_stop') { callbacks.onDone(full); return; }
					} catch {
						buf = line + '\n' + buf;
					}
				}
			}
			callbacks.onDone(full);
		} catch (err: unknown) { if (!(err instanceof Error && err.name === 'AbortError')) { callbacks.onError(err instanceof Error ? err : new Error(String(err))); } }
	}

	async embed(_texts: string[]): Promise<number[][]> {
		throw new Error('Embeddings not supported by the Anthropic API. The codebase index will use keyword-only search. To enable semantic search, configure an OpenAI-compatible provider.');
	}

	async listModels(): Promise<AIModel[]> {
		return [
			{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', maxTokens: 200000, supportsThinking: true, supportsPromptCaching: true },
			{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7', maxTokens: 200000, supportsThinking: true, supportsPromptCaching: true },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
		];
	}

	// AIMessage uses the Anthropic block format. Only the tool role differs on the wire.
	private _convertMessages(messages: AIMessage[]) {
		return messages.filter(msg => msg.role !== 'system').map(msg => {
			if (msg.role !== 'tool') {
				return { role: msg.role, content: msg.content };
			}
			const content = typeof msg.content === 'string' && msg.toolCallId
				? [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }]
				: msg.content;
			return { role: 'user', content };
		});
	}
}
