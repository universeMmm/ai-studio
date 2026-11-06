/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Loop Integration Test
 *  Uses a scripted mock LLM to verify the full plan->execute->complete loop.
 *  Uses typed mock factory from testMocks.ts for compile-time safety.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createTestAgent, MockAIModelService } from './helpers/testMocks.js';

suite('AgentLoop - Integration', () => {

	test('single end_turn completes immediately', async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'end_turn' }]);
		const agent = createTestAgent({ aiModelService: mockModel });
		await agent.run('Do nothing');
		assert.strictEqual(agent.status, 'stopped', 'should stop after end_turn');
		assert.ok(agent.steps.length >= 2, 'should record the instruction and response');
	});

	test('a model-requested plan is presented before execution resumes', async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([
			{ type: 'tool_use', toolName: 'EnterPlanMode' },
			{ type: 'tool_use', toolName: 'ExitPlanMode', toolInput: { content: '修改前先检查测试。' } },
			{ type: 'text', text: 'Plan approved' },
		]);
		const agent = createTestAgent({ aiModelService: mockModel });
		const listener = agent.onDidChangeStatus(status => {
			if (status === 'waiting_for_approval') {
				queueMicrotask(() => agent.approvePlan(true));
			}
		});
		try {
			await agent.run('Test plan');
			const planIndex = agent.steps.findIndex(step => step.type === 'plan');
			const replyIndex = agent.steps.findIndex(step => step.content === 'Plan approved');
			assert.ok(planIndex >= 0 && replyIndex > planIndex);
		} finally {
			listener.dispose();
			agent.dispose();
		}
	});

	test('stop() during run changes status', async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'tool_use', toolName: 'list_directory', toolInput: { path: '.' } }, { type: 'end_turn' }]);
		const agent = createTestAgent({ aiModelService: mockModel });
		const runPromise = agent.run('List dir then stop');
		await new Promise(r => setTimeout(r, 10));
		agent.stop();
		await runPromise;
		assert.strictEqual(agent.status, 'stopped');
	});

	test('5 consecutive errors sets error status', async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([
			{ type: 'error' }, { type: 'error' }, { type: 'error' },
			{ type: 'error' }, { type: 'error' },
		]);
		const agent = createTestAgent({ aiModelService: mockModel });
		agent.maxSteps = 10;
		await agent.run('This will fail');
		assert.strictEqual(agent.status, 'error', 'should be error after max retries');
		const errorSteps = agent.steps.filter(s => s.type === 'error');
		assert.ok(errorSteps.length >= 1, 'should have at least 1 error step');
	});

	test('clearHistory after run resets everything', async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'end_turn' }]);
		const agent = createTestAgent({ aiModelService: mockModel });
		await agent.run('Do thing');
		assert.ok(agent.memory.messageCount > 0);
		assert.ok(agent.steps.length > 0);
		agent.clearHistory();
		assert.strictEqual(agent.steps.length, 0);
		assert.strictEqual(agent.memory.messageCount, 0);
	});

});
