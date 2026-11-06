/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { CustomProvider } from '../../../src/vs/platform/ai/common/customProvider.js';
import type { AIMessage, AIRequestOptions, AITool } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { assistantToolMessage, collectAgentTurn, toolResult } from '../../../src/vs/platform/ai/common/toolRuntime.js';

const options: AIRequestOptions = { model: 'deepseek-v4-pro', maxTokens: 4096, temperature: 0, thinking: true, reasoningEffort: 'high', cacheSystemPrompt: false, maxContextTokens: 32000 };
const tools: AITool[] = [{ name: 'read_file', description: 'Read a project file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

function response(events: unknown[]): Response {
	const bytes = new TextEncoder().encode(events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event))).join('\r\n\r\n'));
	// Split UTF-8 and SSE records so reasoning is covered by the production streaming parser.
	return new Response(new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += 3) { controller.enqueue(bytes.slice(i, i + 3)); }
			controller.close();
		},
	}));
}

suite('Provider reasoning continuity', () => {
	test('replays exact reasoning through two tool rounds and a completed text-only assistant turn', async () => {
		const originalFetch = globalThis.fetch;
		const provider = new CustomProvider('https://api.deepseek.com/v1', 'fixture-key', options.model, new NullLogService());
		const expectedReasoning = ['先检查入口。', '再确认测试。', '完成核对。'];
		let requests = 0;
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.strictEqual(init?.redirect, 'error');
			assert.strictEqual(body.reasoning_effort, 'high');
			assert.deepStrictEqual(body.thinking, { type: 'enabled' });
			assert.strictEqual(Object.hasOwn(body, 'temperature'), false);
			const assistants = body.messages.filter((message: { role: string }) => message.role === 'assistant');
			assert.strictEqual(assistants.length, requests);
			assert.deepStrictEqual(assistants.map((message: { reasoning_content?: string }) => message.reasoning_content), expectedReasoning.slice(0, requests));
			for (let i = 0; i < Math.min(requests, 2); i++) {
				assert.strictEqual(assistants[i].tool_calls[0].id, 'read-' + i);
				assert.strictEqual(body.messages.some((message: { tool_call_id?: string }) => message.tool_call_id === 'read-' + i), true);
			}
			const round = requests++;
			if (round < 2) {
				return response([
					{ choices: [{ delta: { reasoning_content: expectedReasoning[round].slice(0, 2) } }] },
					{ choices: [{ delta: { reasoning_content: expectedReasoning[round].slice(2), content: '读取文件。' } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-' + round, function: { name: 'read_file', arguments: '{"path":' } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"entry.ts"}' } }] } }] },
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
				]);
			}
			return response([
				{ choices: [{ delta: { reasoning_content: round === 2 ? expectedReasoning[2] : '', content: '已完成。' } }] },
				{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]',
			]);
		};
		try {
			const messages: AIMessage[] = [{ role: 'user', content: '检查入口和测试' }];
			for (let round = 0; round < 2; round++) {
				const turn = await collectAgentTurn(provider, messages, tools, options, new AbortController().signal);
				assert.strictEqual(turn.text, '读取文件。');
				assert.strictEqual(turn.reasoningContent, expectedReasoning[round]);
				assert.strictEqual(turn.calls.length, 1);
				messages.push(assistantToolMessage(turn), { role: 'tool', content: [toolResult(turn.calls[0].id, 'file contents', 'success')] });
			}
			const final = await collectAgentTurn(provider, messages, tools, options, new AbortController().signal);
			assert.strictEqual(final.text, '已完成。');
			assert.strictEqual(final.calls.length, 0);
			messages.push(assistantToolMessage(final), { role: 'user', content: '继续检查' });
			const next = await collectAgentTurn(provider, messages, tools, options, new AbortController().signal);
			assert.strictEqual(next.reasoningContent, '');
			assert.strictEqual(requests, 4);
		} finally {
			globalThis.fetch = originalFetch;
			provider.dispose();
		}
	});

	test('only DeepSeek capability backfills legacy assistant reasoning, including compatible proxy models', async () => {
		const originalFetch = globalThis.fetch;
		const history: AIMessage[] = [
			{ role: 'user', content: 'earlier question' },
			{ role: 'assistant', content: 'older plain text answer' },
			{ role: 'assistant', content: [{ type: 'text', text: 'older structured answer' }] },
			{ role: 'assistant', content: 'answer from a previous reasoning model', reasoningContent: 'retained reasoning' },
			{ role: 'user', content: 'continue' },
		];
		try {
			for (const [apiBase, model, expected] of [
				['https://api.deepseek.com/v1', 'deepseek-v4-pro', true],
				['https://proxy.invalid/v1', 'deepseek/deepseek-v4-pro', true],
				['https://api.deepseek.com.evil.invalid/v1', 'generic-model', false],
				['https://api.openai.com/v1', 'gpt-4o', false],
			] as const) {
				const provider = new CustomProvider(apiBase, 'fixture-key', model, new NullLogService());
				globalThis.fetch = async (_url, init) => {
					const body = JSON.parse(String(init?.body));
					for (const message of body.messages) {
						assert.strictEqual(Object.hasOwn(message, 'reasoning_content'), expected && message.role === 'assistant');
						if (Object.hasOwn(message, 'reasoning_content')) {
							assert.strictEqual(message.reasoning_content, message.content === 'answer from a previous reasoning model' ? 'retained reasoning' : '');
						}
					}
					return response([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, '[DONE]']);
				};
				try {
					await collectAgentTurn(provider, history, tools, { ...options, reasoningEffort: 'default' }, new AbortController().signal);
				} finally { provider.dispose(); }
			}
		} finally { globalThis.fetch = originalFetch; }
	});
});
