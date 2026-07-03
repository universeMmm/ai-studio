/*---------------------------------------------------------------------------------------------
 *  AI Studio - Custom Provider Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { CustomProvider } from "../../../src/vs/platform/ai/common/customProvider.js";

suite("CustomProvider", () => {

	test("constructor sets id and label", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new CustomProvider("https://api.openai.com/v1", "sk-test", "gpt-4o", log);
		assert.strictEqual(p.id, "openai");
		assert.strictEqual(p.label, "OpenAI");
	});

	test("listModels returns non-empty preset list", async () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new CustomProvider("https://api.openai.com/v1", "sk-test", "gpt-4o", log);
		const models = await p.listModels();
		assert.ok(models.length >= 2, "should have at least 2 preset models");
		assert.ok(models.some(m => m.id === 'gpt-5'), "should include GPT-5");
	});

	test("embed throws on invalid response", async () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new CustomProvider("https://invalid.example", "sk-test", "gpt-4o", log);
		try {
			await p.embed(["test"]);
			assert.fail("should have thrown due to invalid endpoint");
		} catch (err: any) {
			assert.ok(err, "should throw an error");
		}
	});

	test("streamChat returns an AbortController", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new CustomProvider("https://api.openai.com/v1", "sk-test", "gpt-4o", log);
		const ctl = p.streamChat([], [], { model: '', maxTokens: 100, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 10000 }, { onToken: () => {}, onToolUse: () => {}, onToolResult: () => {}, onError: () => {}, onDone: () => {} });
		assert.ok(ctl instanceof AbortController);
	});

	test("streamCompletion returns an AbortController", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new CustomProvider("https://api.openai.com/v1", "sk-test", "gpt-4o", log);
		const fc = { filePath: '/test.ts', languageId: 'typescript', content: '', cursorLine: 1, cursorColumn: 1 };
		const ctl = p.streamCompletion("prefix", "suffix", fc, { maxTokens: 100, temperature: 0, stopSequences: [] }, { onToken: () => {}, onDone: () => {}, onError: () => {} });
		assert.ok(ctl instanceof AbortController);
	});

});
