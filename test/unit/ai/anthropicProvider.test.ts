/*---------------------------------------------------------------------------------------------
 *  AI Studio - Anthropic Provider Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { AnthropicProvider } from "../../../src/vs/platform/ai/common/anthropicProvider.js";

suite("AnthropicProvider", () => {

	test("constructor sets id and label", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new AnthropicProvider("sk-test", "claude-test", undefined, log);
		assert.strictEqual(p.id, "anthropic");
		assert.strictEqual(p.label, "Anthropic");
	});

	test("embed throws clear error", async () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new AnthropicProvider("sk-test", "claude-test", undefined, log);
		try {
			await p.embed(["test"]);
			assert.fail("should have thrown");
		} catch (err: any) {
			assert.ok(err.message.includes("Embeddings not supported"), "expected clear error message, got: " + err.message);
		}
	});

	test("listModels returns expected models", async () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new AnthropicProvider("sk-test", "claude-test", undefined, log);
		const models = await p.listModels();
		assert.ok(models.length >= 2, "should have at least 2 models");
		assert.ok(models.some(m => m.id.startsWith('claude-')), "should have Claude models");
	});

	test("streamChat returns an AbortController", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new AnthropicProvider("sk-test", "claude-test", undefined, log);
		const ctl = p.streamChat([], [], { model: '', maxTokens: 100, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 10000 }, { onToken: () => {}, onToolUse: () => {}, onToolResult: () => {}, onError: () => {}, onDone: () => {} });
		assert.ok(ctl instanceof AbortController, "should return AbortController");
	});

	test("streamCompletion returns an AbortController", () => {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		const p = new AnthropicProvider("sk-test", "claude-test", undefined, log);
		const fc = { filePath: '/test.ts', languageId: 'typescript', content: '', cursorLine: 1, cursorColumn: 1 };
		const ctl = p.streamCompletion("prefix", "suffix", fc, { maxTokens: 100, temperature: 0, stopSequences: [] }, { onToken: () => {}, onDone: () => {}, onError: () => {} });
		assert.ok(ctl instanceof AbortController, "should return AbortController");
	});

});
