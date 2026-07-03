/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Service Tests
 *  Uses typed mock factory from testMocks.ts for compile-time safety.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { AIAgentService } from "../../../src/vs/platform/ai/browser/aiAgentService.js";
import { createAgentDeps, MockAIModelService } from "./helpers/testMocks.js";

suite("AIAgentService", () => {
	let agent: AIAgentService;

	beforeEach(() => {
		const deps = createAgentDeps();
		agent = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
	});

	test("initial status is idle", () => {
		assert.strictEqual(agent.status, "idle");
	});

	test("initial steps are empty", () => {
		assert.strictEqual(agent.steps.length, 0);
	});

	test("maxSteps defaults to 20", () => {
		assert.strictEqual(agent.maxSteps, 20);
	});

	test("stop changes status to stopped", () => {
		agent.stop();
		assert.strictEqual(agent.status, "stopped");
	});

	test("clearHistory resets steps", () => {
		agent.clearHistory();
		assert.strictEqual(agent.steps.length, 0);
	});

	test("clearHistory resets plan to null", () => {
		agent.clearHistory();
		assert.strictEqual(agent.plan, null);
	});

	test("memory is accessible", () => {
		assert.ok(agent.memory, "memory should exist");
		assert.strictEqual(agent.memory.messageCount, 0);
	});

	test("status events fire on state change", (done) => {
		let fired = false;
		agent.onDidChangeStatus((status) => {
			if (!fired) { fired = true; done(); }
		});
		agent.stop();
	});

	test("fresh agent is idle after stop", () => {
		agent.stop();
		assert.strictEqual(agent.status, "stopped");
		const deps = createAgentDeps();
		const fresh = new AIAgentService(
			deps.aiModelService, deps.indexService, deps.contextService,
			deps.fileService, deps.logService, deps.configurationService,
			deps.diffStore, deps.markerService, deps.workspaceContextService,
		);
		assert.strictEqual(fresh.status, "idle");
	});

});
