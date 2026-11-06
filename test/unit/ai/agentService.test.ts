/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Service Tests
 *  Uses typed mock factory from testMocks.ts for compile-time safety.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AIAgentService } from '../../../src/vs/platform/ai/browser/aiAgentService.js';
import { createTestAgent } from './helpers/testMocks.js';

suite('AIAgentService', () => {
	let agent: AIAgentService;

	setup(() => {
		agent = createTestAgent();
	});

	test('initial status is idle', () => {
		assert.strictEqual(agent.status, 'idle');
	});

	test('initial steps are empty', () => {
		assert.strictEqual(agent.steps.length, 0);
	});

	test('maxSteps defaults to 20', () => {
		assert.strictEqual(agent.maxSteps, 20);
	});

	test('stop changes status to stopped', () => {
		agent.stop();
		assert.strictEqual(agent.status, 'stopped');
	});

	test('clearHistory resets steps', () => {
		agent.clearHistory();
		assert.strictEqual(agent.steps.length, 0);
	});

	test('clearHistory clears a populated conversation', () => {
		agent.memory.addTurn('question', 'answer');
		agent.clearHistory();
		assert.strictEqual(agent.memory.messageCount, 0);
	});

	test('memory is accessible', () => {
		assert.ok(agent.memory, 'memory should exist');
		assert.strictEqual(agent.memory.messageCount, 0);
	});

	test('status events fire on state change', (done) => {
		let fired = false;
		agent.onDidChangeStatus((status) => {
			if (!fired) { fired = true; done(); }
		});
		agent.stop();
	});

	test('fresh agent is idle after stop', () => {
		agent.stop();
		assert.strictEqual(agent.status, 'stopped');
		const fresh = createTestAgent();
		assert.strictEqual(fresh.status, 'idle');
	});

});
