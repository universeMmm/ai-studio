/*---------------------------------------------------------------------------------------------
 *  AI Studio — OpenAI / Custom Provider
 *  Uses native fetch() to call any OpenAI-compatible API — no npm SDK needed.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { IAIProvider } from './aiProvider.js';
import type {
	AIMessage, AITool, AIRequestOptions, AIStreamCallbacks,
	AICompletionOptions, AICompletionCallbacks, FileContext, AIModel,
} from './aiTypes.js';
import { SYSTEM_PROMPT, COMPLETION_SYSTEM_PROMPT } from './systemPrompt.js';

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
			const body: any = {
				model: this.modelId,
				max_tokens: options.maxTokens || 16000,
				temperature: options.temperature ?? 0,
				messages: [{ role: 'system', content: this._systemPrompt() }, ...this._convertMessages(messages)],
				stream: true,
			};
			if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

			const res = await this._fetch('/chat/completions', body, signal);
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '', toolCallId = '', toolName = '', toolArgs = '', toolIdx = -1;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') { callbacks.onDone('end_turn'); return; }
					try {
						const json = JSON.parse(data);
						if (json.usage) {
							callbacks.onUsage?.({ inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens });
						}
						const delta = json.choices?.[0]?.delta;
						if (delta?.content) callbacks.onToken(delta.content);
						if (delta?.tool_calls) {
							for (const tc of delta.tool_calls) {
								if (tc.index !== toolIdx) {
									if (toolCallId) { try { callbacks.onToolUse(toolName, JSON.parse(toolArgs), toolCallId); } catch { callbacks.onToolUse(toolName, {}, toolCallId); } }
									toolIdx = tc.index!; toolCallId = tc.id ?? ''; toolName = tc.function?.name ?? ''; toolArgs = '';
								}
								if (tc.function?.arguments) toolArgs += tc.function.arguments;
							}
						}
						const reason = json.choices?.[0]?.finish_reason;
						if (reason === 'stop') { callbacks.onDone('end_turn'); return; }
						if (reason === 'tool_calls') { if (toolCallId) { try { callbacks.onToolUse(toolName, JSON.parse(toolArgs), toolCallId); } catch { callbacks.onToolUse(toolName, {}, toolCallId); } } callbacks.onDone('tool_use'); return; }
						if (reason === 'length') { callbacks.onDone('max_tokens'); return; }
					} catch {
						// JSON spans chunk boundary — re-append for next chunk
						buffer = line + '\n' + buffer;
					}
				}
			}
			callbacks.onDone('end_turn');
		} catch (err: any) { if (err?.name !== 'AbortError') { this.logService.error('[CustomProvider]', err); callbacks.onError(err); } }
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
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') { callbacks.onDone(full); return; }
					try { const t = JSON.parse(data).choices?.[0]?.delta?.content; if (t) { full += t; callbacks.onToken(t); } } catch {
						buffer = line + '\n' + buffer;
					}
				}
			}
			callbacks.onDone(full);
		} catch (err: any) { if (err?.name !== 'AbortError') callbacks.onError(err); }
	}

	// ── Embeddings + Models ──────────────────────────────────

	async embed(texts: string[]): Promise<number[][]> {
		const res = await this._fetch('/embeddings', { model: 'text-embedding-3-small', input: texts }, new AbortController().signal);
		const json: any = await res.json();
		if (!json.data?.length) throw new Error("Empty embedding response");
		return json.data.map((d: any) => d.embedding);
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

	private async _fetch(path: string, body: any, signal: AbortSignal): Promise<Response> {
		const url = (this.apiBase.endsWith('/') ? this.apiBase.slice(0, -1) : this.apiBase) + path;
		const res = await fetch(url, {
			method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey, 'HTTP-Referer': 'ai-studio', 'X-Title': 'AI Studio' }, body: JSON.stringify(body), signal,
		});
		if (!res.ok) { const text = await res.text(); throw new Error(`API ${res.status}: ${text.slice(0, 500)}`); }
		return res;
	}

	private _systemPrompt() { return SYSTEM_PROMPT; }

	private _convertMessages(msgs: AIMessage[]): any[] {
		return msgs.map(msg => {
			if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
			const toolCalls: any[] = []; let text = '';
			for (const b of msg.content) { if (b.type === 'text') text += (b.text || ''); if (b.type === 'tool_use') toolCalls.push({ id: b.id || '', type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) } }); }
			const r: any = { role: msg.role }; if (text) r.content = text; if (toolCalls.length) r.tool_calls = toolCalls;
			return r;
		});
	}
}
