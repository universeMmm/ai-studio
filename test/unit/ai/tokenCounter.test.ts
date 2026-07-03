/*---------------------------------------------------------------------------------------------
 *  AI Studio - Token Counter Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { countTokens, countMessageTokens } from "../../../src/vs/platform/ai/common/tokenCounter.js";

suite("TokenCounter", () => {

	test("empty string returns 0", () => {
		assert.strictEqual(countTokens(""), 0);
	});

	test("simple English text", () => {
		const tokens = countTokens("Hello world, this is a test.");
		assert.ok(tokens > 3, "Expected >3 tokens, got " + tokens);
		assert.ok(tokens < 20, "Expected <20 tokens, got " + tokens);
	});

	test("code snippet", () => {
		const code = "function hello() {\n  return 'world';\n}";
		const tokens = countTokens(code);
		assert.ok(tokens > 5, "Expected >5 tokens, got " + tokens);
		assert.ok(tokens < 30, "Expected <30 tokens, got " + tokens);
	});

	test("long text produces more tokens than short text", () => {
		const short = countTokens("hi");
		const long = countTokens("function calculateTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }");
		assert.ok(long > short, "Expected long > short, got " + long + " vs " + short);
	});

	test("multiline string", () => {
		const text = "line1\nline2\nline3\nline4";
		const tokens = countTokens(text);
		assert.ok(tokens >= 4, "Expected >=4 tokens, got " + tokens);
	});

	test("special characters", () => {
		const text = "const x = (a: number) => a * 2;";
		const tokens = countTokens(text);
		assert.ok(tokens > 5, "Expected >5 tokens for special chars, got " + tokens);
	});

	test("countMessageTokens with string content", () => {
		const messages = [
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: "Hello" },
		];
		const tokens = countMessageTokens(messages);
		assert.ok(tokens > 8, "Expected >8 tokens (4 overhead per message), got " + tokens);
	});

	test("countMessageTokens with array content blocks", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Hello there" }] },
		];
		const tokens = countMessageTokens(messages);
		assert.ok(tokens > 4, "Expected >4 tokens, got " + tokens);
	});

	test("countMessageTokens with mixed content types", () => {
		const messages = [
			{ role: "assistant", content: [
				{ type: "text", text: "Let me use a tool." },
				{ type: "tool_use", id: "1", name: "read_file", input: { path: "test.ts" } },
			]},
		];
		const tokens = countMessageTokens(messages);
		assert.ok(tokens > 4, "Expected >4 tokens for mixed content, got " + tokens);
	});

});
