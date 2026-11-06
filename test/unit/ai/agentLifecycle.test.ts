/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 * AI Studio — cancellation and session lifecycle regressions.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../src/vs/base/common/async.js';
import type { AgentSession } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { createAgentDeps, createTestAgent } from './helpers/testMocks.js';

suite('Agent lifecycle', () => {
	test('stop while loading history never starts the model or overwrites the active session', async () => {
		const deps = createAgentDeps();
		const loading = new DeferredPromise<void>();
		const proceed = new DeferredPromise<void>();
		const history = deps.fileService.resolve.bind(deps.fileService);
		deps.fileService.resolve = async (...args: Parameters<typeof history>) => {
			await loading.complete();
			await proceed.p;
			return history(...args);
		};
		let streams = 0;
		deps.aiModelService.streamChat = () => { streams++; return new AbortController(); };
		const agent = createTestAgent(deps);
		try {
			const first = agent.run('first');
			await loading.p;
			agent.stop();
			await agent.run('overlap');
			await proceed.complete();
			await first;
			assert.strictEqual(agent.status, 'stopped');
			assert.strictEqual(streams, 0);
		} finally { agent.dispose(); }
	});

	test('stop settles run even when the provider does not call back on abort', async () => {
		const deps = createAgentDeps();
		const started = new DeferredPromise<void>();
		const controller = new AbortController();
		deps.aiModelService.streamChat = () => { void started.complete(); return controller; };
		const agent = createTestAgent(deps);
		try {
			const run = agent.run('cancel');
			await started.p;
			agent.stop();
			await run;
			assert.strictEqual(controller.signal.aborted, true);
			assert.strictEqual(agent.status, 'stopped');
		} finally { agent.dispose(); }
	});

	test('a context initialization error is archived and the next run can complete', async () => {
		const deps = createAgentDeps();
		const saved: AgentSession[] = [];
		const build = deps.contextService.buildContext.bind(deps.contextService);
		deps.contextService.buildContext = async () => { throw new Error('context failed'); };
		deps.fileService.writeFile = async (_resource, data) => {
			saved.push(JSON.parse(data.toString()));
			return {} as Awaited<ReturnType<typeof deps.fileService.writeFile>>;
		};
		const agent = createTestAgent(deps);
		try {
			await agent.run('first');
			assert.strictEqual(agent.status, 'error');
			assert.strictEqual(saved[0].status, 'error');
			assert.ok(saved[0].steps.some(step => step.type === 'error' && step.content === 'context failed'));
			deps.contextService.buildContext = build;
			await agent.run('next');
			assert.strictEqual(agent.status, 'stopped');
			assert.strictEqual(saved[1].instruction, 'next');
		} finally { agent.dispose(); }
	});
});
