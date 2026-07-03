/*---------------------------------------------------------------------------------------------
 *  AI Studio — E2E Smoke Test
 *  Verifies the AI platform modules load and have correct structure.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { BuiltInToolName } from "../../src/vs/platform/ai/common/aiTypes.js";
import { getBuiltInTools } from "../../src/vs/platform/ai/common/aiTools.js";
import { countTokens, countMessageTokens } from "../../src/vs/platform/ai/common/tokenCounter.js";
import { ConversationMemory } from "../../src/vs/platform/ai/common/conversationMemory.js";
import { chunkFile } from "../../src/vs/platform/ai/common/chunker.js";
import { astChunkFile } from "../../src/vs/platform/ai/common/astChunker.js";

suite("AI Platform — E2E Smoke", () => {

	test("aiTypes exports exist", () => {
		assert.ok(BuiltInToolName, "BuiltInToolName enum should exist");
		assert.ok(BuiltInToolName.ReadFile, "ReadFile should exist");
	});

	test("built-in tools are well-formed", () => {
		const tools = getBuiltInTools();
		assert.ok(tools.length >= 8, "Expected >=8 built-in tools, got " + tools.length);
		for (const t of tools) {
			assert.ok(t.name, "Tool must have a name");
			assert.ok(t.description, "Tool " + t.name + " must have a description");
			assert.ok(t.input_schema, "Tool " + t.name + " must have an input_schema");
			assert.strictEqual(t.input_schema.type, "object");
			assert.ok(t.input_schema.properties);
		}
	});

	test("tokenCounter works", () => {
		assert.strictEqual(countTokens(""), 0);
		const hw = countTokens("Hello world");
		assert.ok(hw >= 2 && hw <= 10, "Hello world should be 2-10 tokens, got " + hw);
	});

	test("conversationMemory works", () => {
		const mem = new ConversationMemory();
		assert.strictEqual(mem.messageCount, 0);
		mem.addTurn("Q", "A");
		assert.strictEqual(mem.messageCount, 2);
	});

	test("chunker works", () => {
		const chunks = chunkFile("/test.ts", "const x = 1;", "typescript");
		assert.ok(chunks.length > 0);
	});

	test("astChunker falls back for unsupported languages", () => {
		const chunks = astChunkFile("/test.rb", "def hello\n  puts 'hi'\nend", "ruby");
		assert.ok(chunks.length > 0);
	});

	test("astChunker chunks TypeScript class", () => {
		const code = "class Calculator {\n  add(a: number, b: number): number {\n    return a + b;\n  }\n}\n";
		const chunks = astChunkFile("/test/calc.ts", code, "typescript");
		assert.ok(chunks.some(c => c.kind === 'class'));
	});

	test("countMessageTokens works", () => {
		const tokens = countMessageTokens([{ role: "system", content: "You are a helper." }]);
		assert.ok(tokens > 4);
	});

});
