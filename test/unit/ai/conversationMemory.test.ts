/*---------------------------------------------------------------------------------------------
 *  AI Studio - Conversation Memory Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { ConversationMemory } from "../../../src/vs/platform/ai/common/conversationMemory.js";

suite("ConversationMemory", () => {
	let memory: ConversationMemory;

	beforeEach(() => {
		memory = new ConversationMemory();
	});

	test("starts with 0 turns", () => {
		assert.strictEqual(memory.messageCount, 0);
		assert.strictEqual(memory.turns.length, 0);
	});

	test("addTurn increments message count by 2", () => {
		memory.addTurn("Hello", "Hi there!");
		assert.strictEqual(memory.messageCount, 2);
		assert.strictEqual(memory.turns.length, 1);
	});

	test("addTurn tracks estimated tokens > 0", () => {
		memory.addTurn("Write a function", "Here is your function code block");
		assert.ok(memory.estimatedTokens > 0, "Expected >0 tokens");
	});

	test("toMessages returns user + assistant messages", () => {
		memory.addTurn("Request", "Response");
		const msgs = memory.toMessages();
		assert.strictEqual(msgs.length, 2);
		assert.strictEqual(msgs[0].role, "user");
		assert.strictEqual(msgs[0].content, "Request");
		assert.strictEqual(msgs[1].role, "assistant");
		assert.strictEqual(msgs[1].content, "Response");
	});

	test("toMessages with multiple turns", () => {
		memory.addTurn("Q1", "A1");
		memory.addTurn("Q2", "A2");
		const msgs = memory.toMessages();
		assert.strictEqual(msgs.length, 4);
		assert.strictEqual(msgs[0].content, "Q1");
		assert.strictEqual(msgs[3].content, "A2");
	});

	test("clear resets all state", () => {
		memory.addTurn("Hello", "World");
		memory.clear();
		assert.strictEqual(memory.messageCount, 0);
		assert.strictEqual(memory.turns.length, 0);
		assert.strictEqual(memory.estimatedTokens, 0);
	});

	test("compactIfNeeded returns false when under threshold", () => {
		memory.addTurn("short Q", "short A");
		const result = memory.compactIfNeeded(100000, 0.8);
		assert.strictEqual(result, false);
	});

	test("compactIfNeeded with only 2 turns returns false even if over threshold", () => {
		memory.addTurn("x".repeat(5000), "y".repeat(5000));
		const result = memory.compactIfNeeded(1000, 0.1);
		assert.strictEqual(result, false);
	});

	test("compactIfNeeded compacts when over threshold with >2 turns", () => {
		memory.addTurn("a".repeat(2000), "b".repeat(2000));
		memory.addTurn("c".repeat(2000), "d".repeat(2000));
		memory.addTurn("e".repeat(2000), "f".repeat(2000));
		const result = memory.compactIfNeeded(100, 0.01);
		assert.strictEqual(result, true);
		assert.strictEqual(memory.turns.length, 3, "Should have 2 recent turns + 1 summary turn");
	});

	test("compactWithSummarizer returns false when under threshold", async () => {
		memory.addTurn("short Q", "short A");
		const result = await memory.compactWithSummarizer(
			async () => "summary",
			100000, 0.8,
		);
		assert.strictEqual(result, false);
	});

	test("compactWithSummarizer compacts and calls summarizer", async () => {
		memory.addTurn("a".repeat(2000), "b".repeat(2000));
		memory.addTurn("c".repeat(2000), "d".repeat(2000));
		memory.addTurn("e".repeat(2000), "f".repeat(2000));
		let summarizerCalled = false;
		const result = await memory.compactWithSummarizer(
			async (turns) => { summarizerCalled = true; assert.ok(turns.length >= 1, "should compact at least 1 turn"); return "LLM-generated summary of prior work."; },
			100, 0.01,
		);
		assert.strictEqual(result, true);
		assert.strictEqual(summarizerCalled, true);
		assert.strictEqual(memory.turns.length, 3, "Should have 2 recent + 1 summary turn = 3");
		assert.strictEqual(memory.turns[0].assistantMessage, "LLM-generated summary of prior work.");
	});

	test("compactWithSummarizer with only 2 turns returns false", async () => {
		memory.addTurn("x".repeat(2000), "y".repeat(2000));
		const result = await memory.compactWithSummarizer(
			async () => "summary",
			1000, 0.1,
		);
		assert.strictEqual(result, false);
	});

});
