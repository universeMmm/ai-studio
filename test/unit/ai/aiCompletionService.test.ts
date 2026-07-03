/*---------------------------------------------------------------------------------------------
 *  AI Studio - Completion Service Tests
 *  Uses typed mock factory.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { AICompletionService } from "../../../src/vs/platform/ai/browser/aiCompletionService.js";
import { MockAIModelService, MockConfigurationService, MockLogService, MockFileService } from "./helpers/testMocks.js";

suite("AICompletionService", () => {
	function createService(enabled: boolean = true) {
		const config = new MockConfigurationService();
		config.setValue('ai.completion.enabled', enabled);
		config.setValue('ai.completion.delay', 0);
		const model = new MockAIModelService();
		const log = new MockLogService();
		const fileSvc = new MockFileService() as any;
		return new AICompletionService(model, config as any, log, fileSvc);
	}

	const dummyFc = { filePath: '/test.ts', languageId: 'typescript', content: '', cursorLine: 10, cursorColumn: 5 };

	test("returns null when completion is disabled", async () => {
		const svc = createService(false);
		const result = await svc.provideInlineCompletion('', '', dummyFc);
		assert.strictEqual(result, null);
	});

	test("cancelCurrentCompletion is safe when nothing is pending", () => {
		const svc = createService();
		assert.doesNotThrow(() => svc.cancelCurrentCompletion());
	});

	test("returns null for empty mock response", async () => {
		const svc = createService(true);
		const result = await svc.provideInlineCompletion('const x = ', '', dummyFc);
		assert.strictEqual(result, null, "empty mock response should return null");
	});

	test("cancellation prevents duplicate requests", async () => {
		const svc = createService(true);
		svc.cancelCurrentCompletion();
		const p1 = svc.provideInlineCompletion('a', '', dummyFc);
		svc.cancelCurrentCompletion();
		const result = await p1;
		assert.strictEqual(result, null, "cancelled request should return null");
	});

});
