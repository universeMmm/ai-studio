/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../src/vs/base/common/uri.js';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import type { AIMessage } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { ConversationMemory, mergeArchivedReasoning } from '../../../src/vs/platform/ai/common/conversationMemory.js';
import { createAgentDeps, createTestAgent } from './helpers/testMocks.js';

suite('Reasoning conversation memory', () => {
	test('real agent restores reasoning across native tool progress, attachments, and service restart', async () => {
		const deps = createAgentDeps();
		const files = new Map<string, string>();
		deps.fileService.writeFile = async (resource, content) => {
			files.set(resource.fsPath, content.toString());
			return {} as Awaited<ReturnType<typeof deps.fileService.writeFile>>;
		};
		deps.fileService.readFile = async resource => ({ value: VSBuffer.fromString(files.get(resource.fsPath) ?? '') } as Awaited<ReturnType<typeof deps.fileService.readFile>>);
		deps.fileService.resolve = async resource => ({
			children: [...files.keys()].filter(path => path.startsWith(resource.fsPath + '/')).map(path => ({ name: path.slice(path.lastIndexOf('/') + 1), resource: URI.file(path), isDirectory: false })),
		} as Awaited<ReturnType<typeof deps.fileService.resolve>>);
		deps.contextService.buildContext = async input => [...input.memory.toMessages(), { role: 'user', content: input.instruction }];
		const requests: AIMessage[][] = [];
		let completedTurns = 0;
		deps.aiModelService.streamChat = (messages, _tools, _options, callbacks) => {
			requests.push(structuredClone(messages));
			if (requests.length === 1) {
				callbacks.onReasoning?.('private tool reasoning');
				callbacks.onToken('先检查任务。');
				callbacks.onToolUse('TaskList', {}, 'task-list');
				callbacks.onDone('tool_use');
				return new AbortController();
			}
			const number = ++completedTurns;
			callbacks.onReasoning?.('private reasoning ' + number);
			callbacks.onToken('answer ' + number);
			callbacks.onDone('end_turn');
			return new AbortController();
		};
		const agent = createTestAgent(deps);
		const instruction = 'question 1\n\n附加文件\n- /repo/entry.ts';
		const history: { requestId: string; userMessage: string; assistantMessage: string }[] = [];
		try {
			await agent.run(instruction, { sessionId: 'chat-a', requestId: 'request-1', sourceUserMessage: 'question 1' });
			assert.strictEqual(agent.memory.turns[0].reasoningContent, 'private reasoning 1');
			assert.strictEqual(agent.memory.turns[0].requestId, 'request-1');
			assert.strictEqual(agent.memory.turns[0].sourceUserMessage, 'question 1');
			assert.strictEqual(requests[1].find(message => message.role === 'assistant')?.reasoningContent, 'private tool reasoning');
			assert.ok([...files.values()].some(content => content.includes('private reasoning 1')));
			assert.ok(agent.steps.every(step => !step.content.includes('private reasoning')));
			// Match the bridge: raw request text and every visible thought, not only the final answer.
			history.push({
				requestId: 'request-1', userMessage: 'question 1',
				assistantMessage: agent.steps.filter(step => step.type === 'thought' && step.content !== instruction).map(step => step.content).join('\n'),
			});
			assert.strictEqual(history[0].assistantMessage, '先检查任务。\nanswer 1');
			// Archive names include start time; ensure the second archive sorts after the first.
			await new Promise(resolve => setTimeout(resolve, 2));
			await agent.run('question 2', { sessionId: 'chat-a', requestId: 'request-2', sourceUserMessage: 'question 2', history });
			assert.strictEqual(requests[2].find(message => message.role === 'assistant')?.reasoningContent, 'private reasoning 1');
			assert.strictEqual(requests[2].find(message => message.role === 'assistant')?.content, history[0].assistantMessage);
			assert.deepStrictEqual(agent.memory.turns.map(turn => turn.reasoningContent), ['private reasoning 1', 'private reasoning 2']);
			assert.deepStrictEqual(agent.memory.turns.map(turn => turn.requestId), ['request-1', 'request-2']);
			history.push({ requestId: 'request-2', userMessage: 'question 2', assistantMessage: 'answer 2' });
		} finally { agent.dispose(); }

		const restored = createTestAgent(deps);
		try {
			await restored.run('question 3', { sessionId: 'chat-a', requestId: 'request-3', sourceUserMessage: 'question 3', history });
			assert.deepStrictEqual(requests[3].filter(message => message.role === 'assistant').map(message => message.reasoningContent), ['private reasoning 1', 'private reasoning 2']);
			assert.ok(restored.steps.every(step => !step.content.includes('private reasoning')));
			await restored.run('unrelated', { sessionId: 'chat-b', history: [history[0]] });
			assert.strictEqual(requests[4].find(message => message.role === 'assistant')?.reasoningContent, undefined, 'another chat must not inherit matching archive identity');
		} finally { restored.dispose(); }
	});

	test('native request identity must also match the original user text and never fall back', () => {
		const archived = [{ requestId: 'original-id', sourceUserMessage: 'question', userMessage: 'question', assistantMessage: 'answer', reasoningContent: 'original', timestamp: 1 }];
		const restored = mergeArchivedReasoning([
			{ requestId: 'original-id', userMessage: 'question', assistantMessage: 'tool progress\nanswer' },
			{ requestId: 'original-id', userMessage: 'edited question', assistantMessage: 'answer' },
			{ requestId: 'different-id', userMessage: 'question', assistantMessage: 'answer' },
			{ userMessage: 'question', assistantMessage: 'answer' },
		], archived);
		assert.deepStrictEqual(restored.map(turn => turn.reasoningContent), ['original', undefined, undefined, 'original']);
		assert.strictEqual(restored[0].sourceUserMessage, 'question');
		assert.strictEqual(restored[1].sourceUserMessage, 'edited question');
		const ambiguous = mergeArchivedReasoning([{ requestId: 'original-id', userMessage: 'question', assistantMessage: 'answer' }], [...archived, { ...archived[0], reasoningContent: 'conflicting data' }]);
		assert.strictEqual(ambiguous[0].reasoningContent, undefined);
	});

	test('native edited or ambiguous text never inherits unrelated archived reasoning', () => {
		const archived = [
			{ userMessage: 'question', assistantMessage: 'answer', reasoningContent: 'original', timestamp: 1 },
			{ userMessage: 'repeat', assistantMessage: 'same answer', reasoningContent: 'first', timestamp: 2 },
			{ userMessage: 'repeat', assistantMessage: 'same answer', reasoningContent: 'second', timestamp: 3 },
		];
		const restored = mergeArchivedReasoning([
			{ userMessage: 'question', assistantMessage: 'answer' },
			{ userMessage: 'edited question', assistantMessage: 'answer' },
			{ userMessage: 'question', assistantMessage: 'edited answer' },
			{ userMessage: 'repeat', assistantMessage: 'same answer' },
		], archived);
		assert.deepStrictEqual(restored.map(turn => turn.reasoningContent), ['original', undefined, undefined, undefined]);
	});

	test('counts hidden reasoning but never includes it in summary input or synthetic answers', async () => {
		const memory = new ConversationMemory();
		const withoutReasoning = new ConversationMemory();
		for (let i = 0; i < 3; i++) {
			memory.addTurn('question ' + i, 'answer ' + i, 'private reasoning '.repeat(100));
			withoutReasoning.addTurn('question ' + i, 'answer ' + i);
		}
		assert.ok(memory.estimatedTokens > withoutReasoning.estimatedTokens + 100);
		assert.strictEqual(memory.toMessages()[1].reasoningContent, 'private reasoning '.repeat(100));
		const compacted = await memory.compactWithSummarizer(async turns => {
			assert.ok(turns.every(turn => !Object.hasOwn(turn, 'reasoningContent')));
			return 'Summary.';
		}, 100);
		assert.strictEqual(compacted, true);
		assert.strictEqual(memory.turns[0].reasoningContent, undefined);
		assert.ok(!memory.turns[0].assistantMessage.includes('private reasoning'));
		assert.ok(memory.estimatedTokens > 100, 'recent uncompressed reasoning is still counted');
	});
});
