/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 * AI Studio — streaming provider regressions.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AnthropicProvider } from '../../../src/vs/platform/ai/common/anthropicProvider.js';
import { CustomProvider } from '../../../src/vs/platform/ai/common/customProvider.js';
import type { IAIProvider } from '../../../src/vs/platform/ai/common/aiProvider.js';
import type { AIMessage, StopReason } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { assistantToolMessage, collectAgentTurn, toolResult, type AgentToolCall } from '../../../src/vs/platform/ai/common/toolRuntime.js';
import { SYSTEM_PROMPT } from '../../../src/vs/platform/ai/common/systemPrompt.js';

const log = new NullLogService();
const endpoint = 'https://fixture.invalid';
const input: AIMessage[] = [
	{ role: 'system', content: SYSTEM_PROMPT + '\nProject rule' },
	{ role: 'assistant', content: [{ type: 'tool_use', id: 'read1', name: 'read_file', input: { path: 'a.png' } }] },
	{
		role: 'tool', content: [{
			type: 'tool_result', tool_use_id: 'read1', content: [
				{ type: 'text', text: 'a.png' },
				{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
			]
		}]
	},
];

async function stream(provider: IAIProvider, events: unknown[], messages = input, fragmented = false) {
	const original = globalThis.fetch;
	let body;
	globalThis.fetch = async (_url, init) => {
		body = JSON.parse(String(init?.body));
		const data = new TextEncoder().encode(events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event))).join('\r\n\r\n'));
		if (!fragmented) { return new Response(data); }
		return new Response(new ReadableStream({
			start(controller) {
				for (let i = 0; i < data.length; i++) { controller.enqueue(data.slice(i, i + 1)); }
				controller.close();
			}
		}));
	};
	try {
		const calls: AgentToolCall[] = [];
		let usage: { inputTokens: number; outputTokens: number } | undefined;
		const reason = await new Promise<StopReason>((resolve, reject) => {
			provider.streamChat(messages, [], { model: 'fixture', maxTokens: 100, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 1000 }, {
				onToken() { }, onToolUse: (name, input, id, inputError) => calls.push({ name, input, id, inputError }), onToolResult() { }, onUsage: counts => { usage = counts; },
				onError: reject, onDone: resolve,
			});
		});
		return { body, reason, usage, calls };
	} finally {
		globalThis.fetch = original;
		provider.dispose();
	}
}

suite('Provider streaming', () => {
	test('OpenAI preserves stop reason and trailing usage, and attaches tool images as user content', async () => {
		const provider = new CustomProvider(endpoint, 'fixture', 'fixture', log);
		const { body, reason, usage } = await stream(provider, [
			{ choices: [{ delta: {}, finish_reason: 'length' }] },
			{ choices: [], usage: { prompt_tokens: 19, completion_tokens: 7 } }, '[DONE]',
		]);
		assert.strictEqual(reason, 'max_tokens');
		assert.deepStrictEqual(usage, { inputTokens: 19, outputTokens: 7 });
		assert.strictEqual(body.stream_options.include_usage, true);
		assert.deepStrictEqual(body.messages.filter((msg: AIMessage) => msg.role === 'system'), [input[0]]);
		assert.deepStrictEqual(body.messages.slice(-2), [
			{ role: 'tool', tool_call_id: 'read1', content: 'a.png' },
			{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
		]);
	});

	test('Anthropic combines usage across events and preserves nested tool result images', async () => {
		const provider = new AnthropicProvider('fixture', 'fixture', endpoint, log);
		const { body, usage } = await stream(provider, [
			{ type: 'message_start', message: { usage: { input_tokens: 23, output_tokens: 1 } } },
			{ type: 'message_delta', usage: { input_tokens: null, output_tokens: 11 } },
			{ type: 'message_stop' },
		]);
		assert.deepStrictEqual(usage, { inputTokens: 23, outputTokens: 11 });
		assert.deepStrictEqual(body.system, [{ type: 'text', text: input[0].content }]);
		assert.deepStrictEqual(body.messages.at(-1), { role: 'user', content: input[2].content });
	});
});

suite('Multi-tool provider protocol', () => {
	const previous: AIMessage[] = [
		assistantToolMessage({
			text: '执行', calls: [
				{ id: 'ok', name: 'read_file', input: { path: 'x' } },
				{ id: 'no', name: 'run_command', input: { command: 'npm test' } },
				{ id: 'err', name: 'read_file', input: {} },
			]
		}),
		{ role: 'tool', content: [toolResult('ok', 'file', 'success'), toolResult('no', 'user declined', 'denied'), toolResult('err', 'missing path', 'error')] },
	];
	const openaiFragment = (index: number, id: string | undefined, name: string | undefined, args: string) => ({
		choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
	});
	const start = (index: number, id: string, name: string) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
	const partial = (index: number, part: string) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
	const end = (index: number) => ({ type: 'content_block_stop', index });

	test('OpenAI interleaved indices preserve IDs, split UTF-8 and malformed arguments, with ordered wire results', async () => {
		const { calls, body } = await stream(new CustomProvider(endpoint, 'fixture', 'fixture', log), [
			openaiFragment(1, 'second', 'edit_file', '{"path":'), openaiFragment(0, 'first', 'read_file', '{"path":'),
			openaiFragment(1, undefined, undefined, '"坏"'), openaiFragment(0, undefined, undefined, '"好"}'),
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
		], previous, true);
		assert.deepStrictEqual(calls.map(c => [c.id, c.input, !!c.inputError]), [['first', { path: '好' }, false], ['second', {}, true]]);
		assert.deepStrictEqual(body.messages.at(-4).tool_calls.map((c: { id: string }) => c.id), ['ok', 'no', 'err']);
		assert.deepStrictEqual(body.messages.slice(-3), [
			{ role: 'tool', tool_call_id: 'ok', content: 'file' }, { role: 'tool', tool_call_id: 'no', content: '[denied] user declined' },
			{ role: 'tool', tool_call_id: 'err', content: '[error] missing path' },
		]);
	});

	test('Anthropic decodes each block separately and sends all tool results under a single user message', async () => {
		const { calls, body } = await stream(new AnthropicProvider('fixture', 'fixture', endpoint, log), [
			start(2, 'second', 'edit_file'), start(1, 'first', 'read_file'),
			partial(1, '{"path":'), partial(2, '{"oops":'), partial(1, '"文件"}'), end(2), end(1),
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
		], previous, true);
		assert.deepStrictEqual(calls.map(c => [c.id, c.input, !!c.inputError]), [['first', { path: '文件' }, false], ['second', {}, true]]);
		assert.deepStrictEqual(body.messages.at(-1), { role: 'user', content: previous[1].content });
	});

	test('incomplete tool streams never dispatch partial calls in either provider', async () => {
		await assert.rejects(stream(new CustomProvider(endpoint, 'fixture', 'fixture', log), [
			openaiFragment(0, 'one', 'write_file', '{"path":"x"}'),
		]), /Incomplete/);
		await assert.rejects(stream(new AnthropicProvider('fixture', 'fixture', endpoint, log), [
			start(0, 'one', 'write_file'), partial(0, '{"path":"x"}'), { type: 'message_stop' },
		]), /Incomplete/);
	});

	test('aborting either provider closes the active transport without dispatch', async () => {
		const original = globalThis.fetch;
		try {
			for (const provider of [new CustomProvider(endpoint, 'fixture', 'fixture', log), new AnthropicProvider('fixture', 'fixture', endpoint, log)]) {
				const abort = new AbortController();
				let signal: AbortSignal | null | undefined;
				globalThis.fetch = (_url, init) => {
					signal = init?.signal;
					return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
				};
				const run = collectAgentTurn(provider, input, [], { model: '', maxTokens: 100, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 1000 }, abort.signal);
				abort.abort();
				await assert.rejects(run, { name: 'AbortError' });
				assert.strictEqual(signal?.aborted, true);
				provider.dispose();
			}
		} finally { globalThis.fetch = original; }
	});
});
