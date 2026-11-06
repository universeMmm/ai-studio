/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IndexStore, type IndexedChunk } from '../../common/indexStore.js';

function chunk(content: string): IndexedChunk {
	return {
		chunk: { id: 'chunk', filePath: '/workspace/file.ts', startLine: 1, endLine: 1, content, kind: 'function', name: 'example' },
		embedding: new Float32Array([1, 0]),
	};
}

suite('IndexStore persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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
