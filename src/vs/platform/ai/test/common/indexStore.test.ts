/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IndexStore, IndexMemoryLimitError, type IndexedChunk, type IndexFileMetadata } from '../../common/indexStore.js';

function chunk(content: string): IndexedChunk {
	return {
		chunk: { id: 'chunk', filePath: '/workspace/file.ts', startLine: 1, endLine: 1, content, kind: 'function', name: 'example' },
		embedding: new Float32Array([1, 0]),
	};
}

suite('IndexStore persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('memory admission preserves the last committed file and deletion releases its budget', async () => {
		let writes = 0;
		const store = new IndexStore({ getFiles: async () => new Map(), replaceFile: async () => { writes++; }, close() { } }, undefined, 8192);
		const entry = chunk('first'); entry.embedding = new Float32Array(1536).fill(1);
		try {
			await store.replaceFile('/workspace/file.ts', [entry]);
			const bytes = store.memory.bytes;
			await assert.rejects(store.replaceFile('/workspace/file.ts', [{ ...entry, embedding: new Float32Array(3072) }]), IndexMemoryLimitError);
			assert.strictEqual(writes, 1); assert.strictEqual(store.memory.bytes, bytes);
			assert.strictEqual(store.getChunks('/workspace/file.ts')[0], entry);
			await assert.rejects(store.replaceFile('/workspace/second.ts', [entry]), IndexMemoryLimitError);
			await store.removeFile('/workspace/file.ts');
			assert.strictEqual(store.memory.bytes, 0);
			await store.replaceFile('/workspace/second.ts', [entry]);
			assert.strictEqual(store.stats.totalFiles, 1);
		} finally { store.close(); }
	});

	test('paged reload applies a lowered memory budget to persisted data', async () => {
		const removed: string[] = [];
		const store = new IndexStore({
			async *scanFiles() {
				for (let i = 0; i < 3; i++) { yield { filePath: '/workspace/' + i, entries: [{ ...chunk('dense'), embedding: new Float32Array(1536).fill(1) }] }; }
			},
			replaceFile: async path => { removed.push(path); }, close() { },
		}, undefined, 8192);
		try {
			await store.initialize();
			assert.strictEqual(store.stats.totalFiles, 1); assert.strictEqual(store.memory.limited, true);
			assert.deepStrictEqual(removed, ['/workspace/1', '/workspace/2']);
		} finally { store.close(); }
	});

	test('cancels paged reload before consuming the remaining records', async () => {
		const controller = new AbortController(); let loaded = 0;
		const store = new IndexStore({
			async *scanFiles(signal) {
				for (let i = 0; i < 1000; i++) { signal?.throwIfAborted(); loaded++; yield { filePath: '/workspace/' + i, entries: [chunk('loaded')] }; }
			}, replaceFile: async () => { }, close() { },
		});
		try {
			const pending = store.initialize(controller.signal);
			queueMicrotask(() => controller.abort());
			await assert.rejects(pending, { name: 'AbortError' });
			assert.ok(loaded < 1000);
		} finally { store.close(); }
	});

	test('excluded records cannot consume the reload budget and evict eligible vectors', async () => {
		const removed: string[] = [];
		const store = new IndexStore({
			async *scanFiles() {
				for (const filePath of ['excluded', 'kept']) { yield { filePath, entries: [{ ...chunk(filePath), embedding: new Float32Array(1536).fill(1) }] }; }
			}, replaceFile: async path => { removed.push(path); }, close() { },
		}, undefined, 8192);
		try {
			await store.initialize(undefined, undefined, record => record.filePath === 'kept');
			assert.deepStrictEqual(removed, ['excluded']); assert.strictEqual(store.memory.limited, false);
			assert.strictEqual(store.getChunks('kept').length, 1);
		} finally { store.close(); }
	});

	test('high-dimensional exact search is cancellable and does not build a large native graph', async () => {
		let built = false;
		const Hnsw = class { constructor() { built = true; throw new Error('Unexpected large graph'); } };
		const store = new IndexStore(undefined, Hnsw as any);
		const vector = new Float32Array(1536).fill(1);
		try {
			for (let i = 0; i < 50000; i++) { await store.replaceFile('/workspace/' + i, [{ ...chunk('dense'), embedding: vector }]); }
			const controller = new AbortController();
			const query = store.searchSemantic(vector, 10, controller.signal);
			queueMicrotask(() => controller.abort());
			await assert.rejects(query, { name: 'AbortError' });
			assert.strictEqual(built, false);
		} finally { store.close(); }
	});

	test('cached vector norms preserve exact cosine ordering and update on replacement', async () => {
		const store = new IndexStore();
		const vectors = [[3, 4], [-3, -4], [4, -3], [1, 1]];
		try {
			for (let i = 0; i < vectors.length; i++) {
				const entry = chunk(String(i)); entry.embedding = new Float32Array(vectors[i]);
				await store.replaceFile('/workspace/' + i, [entry]);
			}
			const result = await store.searchSemantic(new Float32Array([3, 4]), 3);
			assert.deepStrictEqual(result.map(hit => hit.chunk.content), ['0', '3', '2']);
			assert.strictEqual(result[0].score, 1);
			const replacement = chunk('replaced'); replacement.embedding = new Float32Array([30, 40]);
			await store.replaceFile('/workspace/0', [replacement]);
			assert.strictEqual((await store.searchSemantic(new Float32Array([3, 4]), 1))[0].score, 1);
		} finally { store.close(); }
	});

	test('fingerprints survive reload, including skipped files, without counting them as indexed files', async () => {
		const files = new Map<string, IndexedChunk[]>();
		const metadata = new Map<string, IndexFileMetadata>();
		const storage = {
			getFiles: async () => files, getMetadata: async () => metadata,
			replaceFile: async (path: string, entries: IndexedChunk[], stamp?: IndexFileMetadata) => {
				files.set(path, entries); if (stamp) { metadata.set(path, stamp); } else { metadata.delete(path); }
			}, close: () => { },
		};
		const stamp = { mtime: 10, size: 123, hash: 'hash', embeddingKey: 'model' };
		const first = new IndexStore(storage);
		await first.initialize();
		await first.replaceFile('/workspace/file.ts', [chunk('saved')], stamp);
		await first.replaceFile('/workspace/large.bin', [], stamp);
		first.close();
		const restored = new IndexStore(storage);
		try {
			await restored.initialize();
			assert.deepStrictEqual(restored.stats, { totalFiles: 1, totalChunks: 1 });
			assert.deepStrictEqual(restored.getMetadata('/workspace/file.ts'), stamp);
			assert.deepStrictEqual(restored.getMetadata('/workspace/large.bin'), stamp);
			await restored.removeFile('/workspace/large.bin');
			assert.strictEqual(restored.getMetadata('/workspace/large.bin'), undefined);
		} finally { restored.close(); }
	});

	test('closes persistence only once when disposed repeatedly', async () => {
		let closeCount = 0;
		const store = new IndexStore({
			getFiles: async () => new Map(),
			replaceFile: async () => { },
			close: () => { closeCount++; },
		});
		store.close();
		store.close();
		// A queued write after close is a no-op and waits for pending cleanup.
		await store.replaceFile('/workspace/file.ts', []);
		assert.strictEqual(closeCount, 1);
		store.close();
		await store.replaceFile('/workspace/file.ts', []);
		assert.strictEqual(closeCount, 1);
	});

	test('awaiting close waits for native handles and queued writes to finish', async () => {
		let release!: () => void;
		let closing = false;
		const store = new IndexStore({
			replaceFile: async () => { },
			close: () => { closing = true; return new Promise<void>(resolve => { release = resolve; }); },
		});
		await store.replaceFile('/workspace/file.ts', [chunk('saved')]);
		let finished = false;
		const closed = store.close();
		assert.strictEqual(store.close(), closed);
		void closed.then(() => { finished = true; });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.ok(closing); assert.strictEqual(finished, false);
		assert.strictEqual(store.stats.totalChunks, 0);
		release(); await closed; assert.ok(finished);
	});

	test('loads stored chunks before semantic search', async () => {
		const stored = chunk('restored');
		const store = new IndexStore({
			getFiles: async () => new Map([[stored.chunk.filePath, [stored]]]),
			replaceFile: async () => { },
			close: () => { },
		});
		try {
			await store.initialize();
			assert.deepStrictEqual(store.stats, { totalFiles: 1, totalChunks: 1 });
			const hits = await store.searchSemantic(new Float32Array([1, 0]), 1);
			assert.strictEqual(hits[0].chunk.content, 'restored');
			assert.strictEqual(hits[0].score, 1);
		} finally {
			store.close();
		}
	});

	test('retains the searchable version when persistence fails', async () => {
		const stored = chunk('original');
		const store = new IndexStore({
			getFiles: async () => new Map([[stored.chunk.filePath, [stored]]]),
			replaceFile: async () => { throw new Error('disk full'); },
			close: () => { },
		});
		try {
			await store.initialize();
			await assert.rejects(store.replaceFile(stored.chunk.filePath, [chunk('replacement')]), /disk full/);
			const hits = await store.searchSemantic(new Float32Array([1, 0]), 1);
			assert.strictEqual(hits[0].chunk.content, 'original');
			assert.deepStrictEqual(store.stats, { totalFiles: 1, totalChunks: 1 });
		} finally {
			store.close();
		}
	});
});
