/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace indexing regression tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Event } from '../../../src/vs/base/common/event.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AIIndexService } from '../../../src/vs/platform/ai/browser/aiIndexService.js';
import type { IAIModelService } from '../../../src/vs/platform/ai/browser/aiModelService.js';
import type { IWorkspaceContextService } from '../../../src/vs/platform/workspace/common/workspace.js';
import type { IFileService } from '../../../src/vs/platform/files/common/files.js';

suite('AIIndexService', () => {
	let temp: string;
	let first: string;
	let second: string;
	let index: AIIndexService;
	const files = { readFile: async (uri: URI) => ({ value: VSBuffer.wrap(await readFile(uri.fsPath)) }) } as IFileService;

	setup(async () => {
		temp = await mkdtemp(join(tmpdir(), 'ai-studio-index-'));
		first = join(temp, 'first');
		second = join(temp, 'second');
		await Promise.all([mkdir(first), mkdir(second)]);
		await Promise.all([writeFile(join(first, 'same.ts'), 'SHARED first'), writeFile(join(second, 'same.ts'), 'SHARED second')]);
	});

	teardown(async () => {
		index?.dispose();
		await rm(temp, { recursive: true, force: true });
	});

	async function start(embed: (texts: string[]) => Promise<number[][]>): Promise<void> {
		const workspace = { getWorkspace: () => ({ folders: [first, second].map(root => ({ uri: URI.file(root) })) }), onDidChangeWorkspaceFolders: Event.None } as IWorkspaceContextService;
		index = new AIIndexService(files, new NullLogService(), workspace, { embed } as IAIModelService);
		if (!index.isReady) { await Event.toPromise(index.onDidBecomeReady); }
	}

	test('keyword search distinguishes the same relative file path in both roots without embeddings', async () => {
		await start(async () => []);
		const result = await index.search('SHARED', 5);
		assert.deepEqual(result.map(hit => hit.filePath).sort(), [join(first, 'same.ts'), join(second, 'same.ts')]);
	});

	test('semantic search replaces and removes files in their owning root using variable-width vectors', async () => {
		await start(async texts => texts.map(text => text.includes('first') ? [1, 0] : [0, 1]));
		assert.equal(index.stats.totalChunks, 2);
		const updated = join(second, 'same.ts');
		await writeFile(updated, 'updated second document');
		await index.indexFile(updated);
		const updatedResult = await index.search('unrelated', 1);
		assert.equal(updatedResult[0].filePath, updated);
		assert.equal(updatedResult[0].content, 'updated second document');
		assert.equal(index.stats.totalChunks, 2);

		await unlink(updated);
		await index.removeFile(updated);
		assert.equal(index.stats.totalChunks, 1);
		assert.equal((await index.search('unrelated', 5)).some(hit => hit.filePath === updated), false);

		await unlink(join(first, 'same.ts'));
		await index.reindex();
		assert.equal(index.stats.totalFiles, 0);
		assert.deepEqual(await index.search('unrelated', 5), []);
	});
});
