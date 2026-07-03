/*---------------------------------------------------------------------------------------------
 *  AI Studio - DiffStore Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { DiffStore } from "../../../src/vs/workbench/contrib/aiDiffApply/browser/diffStore.js";
import type { DiffGroup, DiffHunk } from "../../../src/vs/workbench/contrib/aiDiffApply/common/diffTypes.js";

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
	return {
		id: "h1",
		filePath: "/test/file.ts",
		originalStartLine: 1,
		originalEndLine: 3,
		modifiedStartLine: 1,
		modifiedEndLine: 4,
		originalText: "old\ncontent\nhere",
		modifiedText: "new\ncontent\nhere\nextra",
		status: "applied",
		...overrides,
	};
}

function makeGroup(overrides: Partial<DiffGroup> = {}): DiffGroup {
	return {
		id: "g1",
		chatMessageId: "",
		hunks: [makeHunk()],
		createdAt: Date.now(),
		...overrides,
	};
}

suite("DiffStore", () => {
	let store: DiffStore;
	let groups: readonly DiffGroup[];

	beforeEach(() => {
		store = new DiffStore(null as any, null as any);
		store.onDidChange(() => { groups = store.groups; });
	});

	test("should start with empty groups", () => {
		assert.strictEqual(store.groups.length, 0);
	});

	test("should add a group", () => {
		const group = makeGroup();
		store.addGroup(group);
		assert.strictEqual(store.groups.length, 1);
		assert.strictEqual(store.groups[0].id, "g1");
	});

	test("should add a group - onDidChange fires", (done) => {
		store.onDidChange(() => {
			assert.strictEqual(store.groups.length, 1);
			done();
		});
		store.addGroup(makeGroup());
	});

	test("should reject a single hunk", () => {
		const group = makeGroup();
		store.addGroup(group);
		store.rejectHunk("g1", "h1");
		assert.strictEqual(store.groups[0].hunks[0].status, "rejected");
	});

	test("should reject all hunks in a group", () => {
		const group = makeGroup({
			hunks: [
				makeHunk({ id: "h1" }),
				makeHunk({ id: "h2" }),
			],
		});
		store.addGroup(group);
		store.rejectAll("g1");
		assert.strictEqual(store.groups[0].hunks[0].status, "rejected");
		assert.strictEqual(store.groups[0].hunks[1].status, "rejected");
	});

	test("rejectHunk should not affect other groups", () => {
		store.addGroup(makeGroup({ id: "g1" }));
		store.addGroup(makeGroup({ id: "g2" }));
		store.rejectHunk("g1", "h1");
		assert.strictEqual(store.groups[0].hunks[0].status, "rejected");
		assert.strictEqual(store.groups[1].hunks[0].status, "applied");
	});

	test("getAppliedHunksForFile should return only applied hunks for file", () => {
		store.addGroup(makeGroup({
			hunks: [
				makeHunk({ id: "h1", filePath: "/a.ts" }),
				makeHunk({ id: "h2", filePath: "/b.ts" }),
			],
		}));
		const result = store.getAppliedHunksForFile("/a.ts");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, "h1");
	});

	test("getAppliedHunksForFile should skip rejected hunks", () => {
		store.addGroup(makeGroup({
			hunks: [
				makeHunk({ id: "h1", filePath: "/a.ts", status: "rejected" }),
				makeHunk({ id: "h2", filePath: "/a.ts" }),
			],
		}));
		const result = store.getAppliedHunksForFile("/a.ts");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, "h2");
	});

	test("getAllAppliedHunks should return all applied hunks across groups", () => {
		store.addGroup(makeGroup({
			id: "g1",
			hunks: [
				makeHunk({ id: "h1" }),
				makeHunk({ id: "h2", status: "rejected" }),
			],
		}));
		store.addGroup(makeGroup({
			id: "g2",
			hunks: [
				makeHunk({ id: "h3" }),
			],
		}));
		const result = store.getAllAppliedHunks();
		assert.strictEqual(result.length, 2);
		assert.ok(result.find(h => h.id === "h1"));
		assert.ok(result.find(h => h.id === "h3"));
	});

	test("rejectHunk on non-existent group should be no-op", () => {
		store.addGroup(makeGroup({ id: "real" }));
		store.rejectHunk("nonexistent", "h1");
		assert.strictEqual(store.groups[0].hunks[0].status, "applied");
	});

	test("multiple groups should maintain order", () => {
		store.addGroup(makeGroup({ id: "first" }));
		store.addGroup(makeGroup({ id: "second" }));
		store.addGroup(makeGroup({ id: "third" }));
		assert.deepStrictEqual(store.groups.map(g => g.id), ["first", "second", "third"]);
	});
});
