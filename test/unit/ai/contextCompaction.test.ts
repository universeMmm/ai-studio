/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { AIMessage, AIRequestOptions, AITool } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { agentContextLimits, compactAgentContext, estimateAgentInputTokens } from '../../../src/vs/platform/ai/common/contextCompaction.js';
import { createAgentDeps, createTestAgent, MockConfigurationService } from './helpers/testMocks.js';
import { SubAgentManager } from '../../../src/vs/platform/ai/browser/subAgentManager.js';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';

const options: AIRequestOptions = { model: 'test', maxTokens: 1000, maxContextTokens: 8000, temperature: 0, thinking: false, cacheSystemPrompt: false };
const instruction = 'Keep all original files and finish the requested analysis.';
function history(): AIMessage[] {
	const messages: AIMessage[] = [{ role: 'system', content: 'Never discard these project rules.' }, { role: 'user', content: instruction }];
	for (let i = 0; i < 5; i++) {
		messages.push({ role: 'assistant', content: [{ type: 'tool_use', name: 'read_file', id: 'call-' + i, input: { path: i + '.txt' } }] });
		messages.push({ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call-' + i, content: 'log line\n'.repeat(700) }] });
	}
	return messages;
}

suite('Agent context compaction', () => {
	test('counts tool input, output and tool schemas in the actual request budget', () => {
		const baseline = estimateAgentInputTokens([], []);
		const messages: AIMessage[] = [
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', input: { value: 'a'.repeat(10000) } }] },
			{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'b'.repeat(10000) }] },
		];
		const tool: AITool = { name: 'example', description: 'c'.repeat(10000), input_schema: { type: 'object', properties: {}, required: [] } };
		assert.ok(estimateAgentInputTokens(messages, []) > baseline + 4000);
		assert.ok(estimateAgentInputTokens(messages, [tool]) > estimateAgentInputTokens(messages, []) + 1900);
	});

	test('shrinks long tool history while preserving rules, task and complete recent tool batch', async () => {
		const messages = history();
		messages[2].reasoningContent = 'PRIVATE_PROTOCOL_REASONING';
		const original = JSON.stringify(messages);
		const summaries: AIMessage[][] = [];
		const next = await compactAgentContext({
			messages, tools: [], options, instruction, signal: new AbortController().signal,
			summarize: async request => { summaries.push(JSON.parse(JSON.stringify(request))); return 'Read several logs. Preserve files; remaining analysis is pending.'; },
		});
		assert.ok(summaries.length > 0);
		assert.ok(estimateAgentInputTokens(next, []) < estimateAgentInputTokens(messages, []));
		assert.ok(estimateAgentInputTokens(next, []) <= options.maxContextTokens - options.maxTokens - 128);
		assert.deepStrictEqual(next[0], messages[0]);
		assert.deepStrictEqual(next[1], messages[1]);
		assert.deepStrictEqual(next.slice(-2), messages.slice(-2));
		for (const request of summaries) {
			assert.ok(!JSON.stringify(request).includes('PRIVATE_PROTOCOL_REASONING'), 'hidden protocol reasoning must not become summary text');
			assert.ok(estimateAgentInputTokens(request, []) < options.maxContextTokens - 1024);
			const summarized = JSON.parse(request[1].content as string) as AIMessage[];
			const blocks = summarized.flatMap(message => Array.isArray(message.content) ? message.content : []);
			assert.deepStrictEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.id), blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
		}
		assert.strictEqual(JSON.stringify(messages), original, 'source messages must stay available for recovery');
	});

	test('summary failure and cancellation leave the source history unchanged', async () => {
		for (const cancel of [false, true]) {
			const messages = history();
			const original = JSON.stringify(messages);
			const controller = new AbortController();
			await assert.rejects(compactAgentContext({
				messages, tools: [], options, instruction, signal: controller.signal,
				summarize: async () => { if (cancel) { controller.abort(); return 'summary'; } throw new Error('summary failed'); },
			}));
			assert.strictEqual(JSON.stringify(messages), original);
		}
	});

	test('rejects empty or expanding summaries without changing history', async () => {
		for (const summary of ['', 'long summary '.repeat(20000)]) {
			const messages = history();
			const original = JSON.stringify(messages);
			await assert.rejects(compactAgentContext({ messages, tools: [], options, instruction, signal: new AbortController().signal, summarize: async () => summary }));
			assert.strictEqual(JSON.stringify(messages), original);
		}
	});

	test('does not split a pending tool batch or erase oversized fixed instructions', async () => {
		const pending = history();
		pending.pop();
		await assert.rejects(compactAgentContext({ messages: pending, tools: [], options, instruction, signal: new AbortController().signal, summarize: async () => 'summary' }), /工具调用尚未完成/);
		const fixed: AIMessage[] = [{ role: 'system', content: 'rules '.repeat(15000) }, { role: 'user', content: instruction }];
		await assert.rejects(compactAgentContext({ messages: fixed, tools: [], options, instruction, signal: new AbortController().signal, summarize: async () => { throw new Error('must not run'); } }), /没有可安全压缩/);
	});

	test('uses the configured model window and reserves response space for smaller models', async () => {
		assert.deepStrictEqual(agentContextLimits(8000, 16000), { maxContextTokens: 8000, maxTokens: 2000 });
		assert.deepStrictEqual(agentContextLimits(128000, 16000), { maxContextTokens: 128000, maxTokens: 16000 });
		let calls = 0;
		await compactAgentContext({ messages: history(), tools: [], options: { ...options, maxContextTokens: 128000 }, instruction, signal: new AbortController().signal, summarize: async () => { calls++; return 'summary'; } });
		assert.strictEqual(calls, 0);
		await compactAgentContext({ messages: history(), tools: [], options, instruction, signal: new AbortController().signal, summarize: async () => { calls++; return 'summary'; } });
		assert.ok(calls > 0);
	});

	test('main agent sends the compacted messages to the next actual model request', async () => {
		const deps = createAgentDeps();
		const config = new MockConfigurationService();
		config.setValue('ai.modelContextTokens', 16000);
		config.setValue('ai.chat.maxTokens', 1000);
		deps.configurationService = config as unknown as typeof deps.configurationService;
		const messages = history();
		deps.contextService.buildContext = async () => messages;
		const requests: { messages: AIMessage[]; tools: AITool[]; options: AIRequestOptions }[] = [];
		deps.aiModelService.streamChat = (active, tools, requestOptions, callbacks) => {
			requests.push({ messages: JSON.parse(JSON.stringify(active)), tools, options: requestOptions });
			queueMicrotask(() => { callbacks.onToken(tools.length ? 'Done' : 'SUMMARY: Earlier files were examined. Continue the requested analysis.'); callbacks.onDone('end_turn'); });
			return new AbortController();
		};
		const agent = createTestAgent(deps);
		try {
			await agent.run(instruction);
			assert.strictEqual(agent.status, 'stopped');
			assert.ok(requests.some(request => !request.tools.length), 'a summary should be requested');
			const actual = requests.find(request => request.tools.length)!;
			assert.ok(actual);
			assert.ok(JSON.stringify(actual.messages).includes('SUMMARY:'));
			assert.ok(estimateAgentInputTokens(actual.messages, actual.tools) < estimateAgentInputTokens(messages, actual.tools));
			assert.strictEqual(actual.options.maxContextTokens, 16000);
		} finally { agent.dispose(); }
	});

	for (const child of [false, true]) {
		test(`${child ? 'child' : 'main'} agent compacts growing tool messages during the same task`, async () => {
			const deps = createAgentDeps();
			const config = new MockConfigurationService();
			config.setValue('ai.modelContextTokens', 16000);
			config.setValue('ai.chat.maxTokens', 1000);
			deps.configurationService = config as unknown as typeof deps.configurationService;
			deps.contextService.buildContext = async () => [{ role: 'system', content: 'Keep the project rules.' }, { role: 'user', content: instruction }];
			deps.fileService.readFile = async () => ({ value: VSBuffer.fromString('log line\n'.repeat(700)) } as Awaited<ReturnType<typeof deps.fileService.readFile>>);
			let turns = 0;
			let summaries = 0;
			const normalRequests: AIMessage[][] = [];
			deps.aiModelService.streamChat = (active, tools, requestOptions, callbacks) => {
				assert.strictEqual(requestOptions.maxContextTokens, 16000);
				assert.ok(estimateAgentInputTokens(active, tools) <= requestOptions.maxContextTokens - requestOptions.maxTokens);
				if (tools.length) { normalRequests.push(JSON.parse(JSON.stringify(active))); }
				queueMicrotask(() => {
					if (!tools.length) { summaries++; callbacks.onToken('SUMMARY: Earlier logs examined. Continue analysis.'); callbacks.onDone('end_turn'); }
					else if (++turns <= 5) {
						callbacks.onToolUse('read_file', { path: 'log.txt', note: 'prior context '.repeat(500) }, 'read-' + turns);
						callbacks.onDone('tool_use');
					} else { callbacks.onToken('Done'); callbacks.onDone('end_turn'); }
				});
				return new AbortController();
			};
			if (child) {
				const manager = new SubAgentManager(deps.aiModelService, deps.logService, deps.fileService, deps.workspaceContextService, deps.configurationService, deps.indexService, deps.diffStore, deps.markerService);
				const results = await manager.execute([{ subagent_type: 'Explore', description: 'analyze', prompt: instruction, run_in_background: false, mode: 'default' }]);
				assert.strictEqual(results[0].status, 'completed', results[0].error);
			} else {
				const agent = createTestAgent(deps);
				try { await agent.run(instruction); assert.strictEqual(agent.status, 'stopped'); }
				finally { agent.dispose(); }
			}
			assert.strictEqual(normalRequests.length, 6);
			assert.ok(summaries > 0, 'tool output growth must trigger compaction even without old conversation memory');
			assert.ok(normalRequests.some(request => JSON.stringify(request).includes('SUMMARY:')));
		});
	}
});
