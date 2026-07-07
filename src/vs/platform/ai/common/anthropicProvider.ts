/*---------------------------------------------------------------------------------------------
 *  AI Studio — Anthropic Provider
 *  Uses native fetch() to call Anthropic Messages API.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { IAIProvider } from './aiProvider.js';
import type {
	AIMessage, AITool, AIRequestOptions, AIStreamCallbacks,
	AICompletionOptions, AICompletionCallbacks, FileContext, AIModel,
} from './aiTypes.js';
import { SYSTEM_PROMPT, COMPLETION_SYSTEM_PROMPT } from './systemPrompt.js';

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
			const body: any = {
				model: this.modelId,
				max_tokens: options.maxTokens || 16000,
				temperature: options.temperature ?? 0,
				system: this._buildSystemBlocks(messages),
				messages: this._convertMessages(messages),
				stream: true,
				thinking: options.thinking ? { type: 'enabled' } : { type: 'disabled' },
			};
			if (options.thinking && this._baseUrl.includes('deepseek')) { body.reasoning_effort = 'high'; }
			if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

			const url = this._baseUrl + '/v1/messages';
			this.logService.info('[Anthropic] POST ' + url + ' model=' + this.modelId);

			const res = await fetch(url, {
				method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', ...(options.cacheSystemPrompt !== false ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}) }, body: JSON.stringify(body), signal,
			});
			if (!res.ok) { const t = await res.text(); throw new Error('Anthropic ' + res.status + ': ' + t.slice(0, 500)); }

			const reader = res.body!.getReader(); const decoder = new TextDecoder();
			let buf = '', toolUseId = '', toolName = '', toolInput = '';
			let eventCount = 0;
			const MAX_EVENT_LOG = 5;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });

				const lines = buf.split('\n');
				buf = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;
					const data = trimmed.slice(6).trim();
					if (!data) continue;
					try {
						const e = JSON.parse(data);
						if (eventCount < MAX_EVENT_LOG) {
							this.logService.info('[Anthropic] SSE event:', JSON.stringify(e).slice(0, 300));
						}
						eventCount++;
						switch (e.type) {
							case 'message_start': break; // stream metadata — ignore
							case 'content_block_start': if (e.content_block?.type === 'tool_use') { toolUseId = e.content_block.id; toolName = e.content_block.name; toolInput = ''; } break;
							case 'content_block_delta': if (e.delta?.type === 'text_delta') callbacks.onToken(e.delta.text); else if (e.delta?.type === 'input_json_delta') toolInput += e.delta.partial_json; break;
							case 'content_block_stop': if (toolUseId) { try { callbacks.onToolUse(toolName, JSON.parse(toolInput), toolUseId); } catch { callbacks.onToolUse(toolName, {}, toolUseId); } toolUseId = ''; toolName = ''; toolInput = ''; } break;
							case 'message_delta': {
								if (e.usage) {
									callbacks.onUsage?.({ inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens });
								}
								break;
							}
							case 'message_stop': this.logService.info('[Anthropic] SSE stream complete — ' + eventCount + ' events, ' + (toolUseId ? 'tool use' : 'text response')); callbacks.onDone('end_turn'); return;
							case 'error': callbacks.onError(new Error(e.error?.message || 'Unknown')); return;
							case 'ping': break; // keepalive
							default:
								this.logService.warn('[Anthropic] Unknown SSE event type:', e.type);
						}
					} catch {
						// JSON spans chunk boundary — re-append for next chunk
						buf = line + '\n' + buf;
					}
				}
			}
			this.logService.info('[Anthropic] SSE stream ended (EOF) — ' + eventCount + ' events');
			callbacks.onDone('end_turn');
		} catch (err: any) { if (err?.name !== 'AbortError') { this.logService.error('[Anthropic]', err); callbacks.onError(err); } }
	}

	streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		const ctl = new AbortController();
		this._streamCompletion(prefix, suffix, fc, options, callbacks, ctl.signal);
		return ctl;
	}

	private async _streamCompletion(prefix: string, suffix: string, fc: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks, signal: AbortSignal): Promise<void> {
		try {
			const body = { model: this.modelId, max_tokens: options.maxTokens || 4096, temperature: options.temperature ?? 0, system: COMPLETION_SYSTEM_PROMPT(fc.languageId, fc.filePath), messages: [{ role: 'user', content: '<code_before>\n' + prefix + '\n</code_before>\n<code_after>\n' + suffix + '\n</code_after>' }], stream: true };
			const res = await fetch(this._baseUrl + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
			const reader = res.body!.getReader(); const d = new TextDecoder(); let buf = '', full = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += d.decode(value, { stream: true });

				const lines = buf.split('\n');
				buf = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
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
		} catch (err: any) { if (err?.name !== 'AbortError') callbacks.onError(err); }
	}

	async embed(_texts: string[]): Promise<number[][]> {
		throw new Error("Embeddings not supported by the Anthropic API. The codebase index will use keyword-only search. To enable semantic search, configure an OpenAI-compatible provider.");
	}

	async listModels(): Promise<AIModel[]> {
		return [
			{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', maxTokens: 200000, supportsThinking: true, supportsPromptCaching: true },
			{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7', maxTokens: 200000, supportsThinking: true, supportsPromptCaching: true },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 384000, supportsThinking: true, supportsPromptCaching: false },
		];
	}

	private _systemPrompt() { return SYSTEM_PROMPT; }

	private _buildSystemBlocks(messages: AIMessage[]): { type: string; text: string }[] {
		const blocks = [{ type: 'text' as const, text: this._systemPrompt() }];
		for (const msg of messages) {
			if (msg.role === 'system' && typeof msg.content === 'string') {
				blocks.push({ type: 'text' as const, text: msg.content });
			}
		}
		return blocks;
	}

	private _convertMessages(msgs: AIMessage[]): any[] {
		const result: any[] = [];
		for (const msg of msgs) {
			if (msg.role === 'system') continue;
			// Anthropic API: tool results go in a user message, not a separate "tool" role
			if (msg.role === 'tool') {
				const raw = typeof msg.content === 'string' ? [{ type: 'text' as const, text: msg.content }] : msg.content;
				const blocks = Array.isArray(raw) ? raw : [];
				const toolResults = blocks.filter((b) => b.type === 'tool_result').map((b) => ({ type: 'tool_result' as const, tool_use_id: (b as { tool_use_id?: string }).tool_use_id || '', content: typeof (b as { content?: unknown }).content === 'string' ? (b as { content: string }).content : '' }));
				const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => ({ type: 'text' as const, text: (b as { text?: string }).text || '' }));
				result.push({ role: 'user', content: [...textBlocks, ...toolResults] });
				continue;
			}
			if (typeof msg.content === 'string') { result.push({ role: msg.role, content: msg.content }); continue; }
			result.push({ role: msg.role, content: msg.content.map((b): any => {
				switch (b.type) { case 'text': return { type: 'text' as const, text: (b as { text?: string }).text || '' }; case 'tool_use': return { type: 'tool_use' as const, id: (b as { id?: string }).id || '', name: (b as { name?: string }).name || '', input: (b as { input?: Record<string, unknown> }).input || {} }; case 'tool_result': return { type: 'tool_result' as const, tool_use_id: (b as { tool_use_id?: string }).tool_use_id || '', content: typeof (b as { content?: unknown }).content === 'string' ? (b as { content: string }).content : '' }; default: return { type: 'text' as const, text: '' }; }
			}) });
		}
		return result;
	}
}
