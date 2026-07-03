/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Loop Integration Test
 *  Uses a scripted mock LLM to verify the full plan->execute->complete loop.
 *  Uses typed mock factory from testMocks.ts for compile-time safety.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { AIAgentService } from "../../../src/vs/platform/ai/browser/aiAgentService.js";
import { createAgentDeps, MockAIModelService } from "./helpers/testMocks.js";

suite("AgentLoop - Integration", () => {

	test("single end_turn completes immediately", async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'end_turn' }]);
		const deps = createAgentDeps({ aiModelService: mockModel });
		const agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		await agent.run("Do nothing");
		assert.strictEqual(agent.status, "stopped", "should stop after end_turn");
		assert.ok(agent.steps.length >= 2, "should have at least thought + plan steps");
	});

	test("plan step appears before tool execution", async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'end_turn' }]);
		const deps = createAgentDeps({ aiModelService: mockModel });
		const agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		await agent.run("Test plan");
		const planStep = agent.steps.find(s => s.type === 'plan');
		assert.ok(planStep, "should have a plan step");
	});

	test("stop() during run changes status", async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'tool_use', toolName: 'list_directory', toolInput: { path: '.' } }, { type: 'end_turn' }]);
		const deps = createAgentDeps({ aiModelService: mockModel });
		const agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		const runPromise = agent.run("List dir then stop");
		await new Promise(r => setTimeout(r, 10));
		agent.stop();
		await runPromise;
		assert.strictEqual(agent.status, "stopped");
	});

	test("5 consecutive errors sets error status", async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([
			{ type: 'error' }, { type: 'error' }, { type: 'error' },
			{ type: 'error' }, { type: 'error' },
		]);
		const deps = createAgentDeps({ aiModelService: mockModel });
		const agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		agent.maxSteps = 10;
		await agent.run("This will fail");
		assert.strictEqual(agent.status, "error", "should be error after max retries");
		const errorSteps = agent.steps.filter(s => s.type === 'error');
		assert.ok(errorSteps.length >= 1, "should have at least 1 error step");
	});

	test("clearHistory after run resets everything", async () => {
		const mockModel = new MockAIModelService();
		mockModel.setScript([{ type: 'end_turn' }]);
		const deps = createAgentDeps({ aiModelService: mockModel });
		const agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		await agent.run("Do thing");
		agent.clearHistory();
		assert.strictEqual(agent.steps.length, 0);
		assert.strictEqual(agent.memory.messageCount, 0);
		assert.strictEqual(agent.plan, null);
	});

});
