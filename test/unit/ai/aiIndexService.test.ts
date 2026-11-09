/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile, stat, realpath, rename, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter, Event } from '../../../src/vs/base/common/event.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AIIndexService } from '../../../src/vs/platform/ai/browser/aiIndexService.js';
import type { IAIModelService } from '../../../src/vs/platform/ai/browser/aiModelService.js';
import type { IWorkspaceContextService } from '../../../src/vs/platform/workspace/common/workspace.js';
import { FileChangesEvent, FileChangeType, FileOperationError, FileOperationResult, type IFileService } from '../../../src/vs/platform/files/common/files.js';
import { TestConfigurationService } from '../../../src/vs/platform/configuration/test/common/testConfigurationService.js';
import type { IConfigurationChangeEvent } from '../../../src/vs/platform/configuration/common/configuration.js';
import type { AIStudioIpcRenderer } from '../../../src/vs/platform/ai/common/desktopIpc.js';

suite('AIIndexService', () => {
	let temp: string, first: string, second: string;
	let index: AIIndexService;
	let configuration: TestConfigurationService;
	let events: Emitter<FileChangesEvent>;
	let folders: Emitter<any>;
	let roots: string[];
	let watchers: number;
	let reads: number;
	const files = {
		readFile: async (uri: URI) => { reads++; return { value: VSBuffer.wrap(await readFile(uri.fsPath)) }; },
		stat: async (uri: URI) => {
			try { const info = await stat(uri.fsPath); return { mtime: info.mtimeMs, size: info.size, isFile: info.isFile(), isSymbolicLink: false }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw new FileOperationError('Missing', FileOperationResult.FILE_NOT_FOUND); } throw error; }
		},
		realpath: async (uri: URI) => URI.file(await realpath(uri.fsPath)),
		watch: () => { watchers++; return { dispose: () => { watchers--; } }; },
		get onDidFilesChange() { return events.event; },
	} as unknown as IFileService;

	setup(async () => {
		temp = URI.file(await mkdtemp(join(tmpdir(), 'ai-studio-index-'))).fsPath;
		first = join(temp, 'first'); second = join(temp, 'second'); roots = [first, second];
		await Promise.all([mkdir(first), mkdir(second)]);
		await Promise.all([writeFile(join(first, 'same.ts'), 'SHARED first'), writeFile(join(second, 'same.ts'), 'SHARED second')]);
		configuration = new TestConfigurationService({ 'ai.index.requestInterval': 0 });
		events = new Emitter(); folders = new Emitter(); watchers = 0; reads = 0;
	});
	teardown(async () => {
		index?.dispose(); events.dispose(); folders.dispose(); configuration.onDidChangeConfigurationEmitter.dispose();
		assert.equal(watchers, 0);
		await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	async function until(condition: () => boolean): Promise<void> {
		const deadline = Date.now() + 10000;
		while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out: ' + JSON.stringify(index?.stats)); await new Promise(resolve => setTimeout(resolve, 10)); }
	}
	async function set(key: string, value: unknown): Promise<void> {
		await configuration.setUserConfiguration(key, value);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (section: string) => key === section || key.startsWith(section + '.') } as IConfigurationChangeEvent);
	}
	function change(path: string, type = FileChangeType.UPDATED): void { events.fire(new FileChangesEvent([{ resource: URI.file(path), type }], false)); }
	async function start(embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>, wait = true): Promise<void> {
		const workspace = { getWorkspace: () => ({ folders: roots.map(root => ({ uri: URI.file(root) })) }), onDidChangeWorkspaceFolders: folders.event } as unknown as IWorkspaceContextService;
		index = new AIIndexService(files, new NullLogService(), workspace, { embed } as IAIModelService, configuration);
		if (wait) { await until(() => index.isReady || !index.stats.enabled); }
	}
	const vectors = async (texts: string[]) => texts.map(text => text.includes('first') ? [1, 0] : [0, 1]);

	test('complete keyword snapshots avoid disk scans and watcher changes use live fallback', async () => {
		roots = [first];
		await writeFile(join(first, 'same.ts'), '// HEADER_ONLY\nexport function first() {}');
		await start(vectors);
		const globals = globalThis as typeof globalThis & { vscode?: { ipcRenderer?: AIStudioIpcRenderer } };
		const previous = globals.vscode; let diskSearches = 0;
		try {
			globals.vscode = { ipcRenderer: { invoke: async () => { diskSearches++; return { exitCode: 0, stdout: './same.ts:1:// UPDATED_HEADER\n', stderr: '' } as any; } } };
			assert.ok((await index.search('HEADER_ONLY', 5)).some(hit => hit.startLine === 1 && hit.content === '// HEADER_ONLY'));
			assert.equal(diskSearches, 0);
			await writeFile(join(first, 'same.ts'), '// UPDATED_HEADER\nexport function first() {}');
			change(join(first, 'same.ts'));
			assert.ok((await index.search('UPDATED_HEADER', 5)).some(hit => hit.content === '// UPDATED_HEADER'));
			assert.equal(diskSearches, 1);
		} finally { globals.vscode = previous; }
		await index.reindex();
		assert.ok((await index.search('UPDATED_HEADER', 5)).some(hit => hit.content === '// UPDATED_HEADER'));
	});

	test('file-limited indexes still find keywords in files outside the vector snapshot', async () => {
		roots = [first];
		await writeFile(join(first, 'z.ts'), 'ONLY_UNINDEXED');
		await set('ai.index.maxFiles', 1); await start(vectors);
		assert.equal(index.stats.limited, true);
		assert.ok((await index.search('ONLY_UNINDEXED', 5)).some(hit => hit.filePath === 'z.ts' && hit.content === 'ONLY_UNINDEXED'));
	});

	test('oversized files keep the live keyword fallback', async () => {
		roots = [first];
		await writeFile(join(first, 'large.ts'), 'padding\n'.repeat(20000) + 'ONLY_OVERSIZED\n');
		await start(vectors);
		assert.equal(index.stats.totalChunks, 1);
		assert.ok((await index.search('ONLY_OVERSIZED', 5)).some(hit => hit.filePath === 'large.ts' && hit.content === 'ONLY_OVERSIZED'));
	});

	test('legacy fingerprints acquire complete text without requesting new embeddings', async () => {
		roots = [first]; let requests = 0;
		await start(async texts => { requests++; return vectors(texts); });
		const store = (index as any).indexes.get(first).builder.getStore();
		const file = join(first, 'same.ts'), originalRequests = requests;
		await store.replaceFile(file, store.getChunks(file), { ...store.getMetadata(file), text: undefined });
		assert.equal(await store.searchKeywords(['SHARED'], 5), undefined);
		await index.reindex();
		assert.equal(requests, originalRequests);
		assert.equal(store.getMetadata(file).text, 'SHARED first');
		assert.equal((await store.searchKeywords(['SHARED'], 5)).length, 1);
	});

	test('keyword fallback respects root-anchored includes for native path separators', async () => {
		roots = [first];
		await set('ai.index.enabled', false); await set('ai.index.include', ['same.ts']);
		await start(vectors);
		assert.deepEqual((await index.search('SHARED', 5)).map(hit => hit.filePath), ['same.ts']);
		// Exercise ripgrep's Windows spelling even when this test runs on Unix.
		const globals = globalThis as typeof globalThis & { vscode?: { ipcRenderer?: AIStudioIpcRenderer } };
		const previous = globals.vscode;
		try {
			globals.vscode = { ipcRenderer: { invoke: async () => ({ exitCode: 0, stdout: '.\\same.ts:1:SHARED first\n', stderr: '' }) as any } };
			assert.equal((await index.search('SHARED', 5)).length, 1);
		} finally { globals.vscode = previous; }
	});

	test('caller cancellation reaches query embeddings and rejects the hybrid search', async () => {
		let searching = false; let requestSignal: AbortSignal | undefined;
		await start(async (texts, signal) => {
			if (searching) { requestSignal = signal; return new Promise(() => { }); }
			return vectors(texts);
		});
		searching = true;
		const controller = new AbortController();
		const pending = index.search('query', 5, controller.signal);
		const rejected = assert.rejects(pending, { name: 'AbortError' });
		await until(() => !!requestSignal); controller.abort();
		await rejected; assert.ok(requestSignal!.aborted);
	});

	test('keyword search distinguishes roots when embeddings are unavailable', async () => {
		await start(async () => []);
		assert.equal(index.stats.state, 'error');
		assert.deepEqual((await index.search('SHARED', 5)).map(hit => hit.filePath).sort(), [join(first, 'same.ts'), join(second, 'same.ts')]);
	});
	test('semantic search replaces and removes files in the owning root', async () => {
		await start(vectors);
		assert.equal(index.stats.totalChunks, 2);
		const updated = join(second, 'same.ts');
		await writeFile(updated, 'updated second document'); await index.indexFile(updated);
		const result = await index.search('unrelated', 1);
		assert.equal(result[0].filePath, updated); assert.equal(result[0].content, 'updated second document');
		await unlink(updated); await index.removeFile(updated);
		assert.equal(index.stats.totalChunks, 1);
		await unlink(join(first, 'same.ts')); await index.reindex();
		assert.equal(index.stats.totalFiles, 0); assert.deepEqual(await index.search('unrelated', 5), []);
	});
	test('unchanged scans skip reads and API calls; touch-only updates skip embeddings', async () => {
		let requests = 0;
		await start(async texts => { requests++; return vectors(texts); });
		const originalRequests = requests, originalReads = reads;
		await index.reindex();
		assert.equal(requests, originalRequests); assert.equal(reads, originalReads);
		const file = join(first, 'same.ts');
		await utimes(file, new Date(), new Date(Date.now() + 2000));
		await index.reindex();
		assert.equal(requests, originalRequests); assert.equal(reads, originalReads + 1);
	});
	test('file watcher coalesces saves and handles creation, rename and directory deletion', async () => {
		let requests = 0;
		await start(async texts => { requests++; return vectors(texts); });
		assert.equal(watchers, 2);
		const file = join(first, 'same.ts');
		await writeFile(file, 'changed first');
		const initial = requests;
		for (let i = 0; i < 50; i++) { change(file); }
		await until(() => requests === initial + 1 && index.stats.state === 'idle');
		await mkdir(join(first, 'folder')); const added = join(first, 'folder', 'new.ts');
		await writeFile(added, 'new first'); change(join(first, 'folder'), FileChangeType.ADDED);
		await until(() => index.stats.totalFiles === 3);
		const renamed = join(first, 'folder', 'renamed.ts');
		await rename(added, renamed); change(added, FileChangeType.DELETED); change(renamed, FileChangeType.ADDED);
		await until(() => requests >= initial + 3 && index.stats.state === 'idle');
		assert.ok(!(await index.search('unrelated', 10)).some(hit => hit.filePath === added));
		await rm(join(first, 'folder'), { recursive: true }); change(join(first, 'folder'), FileChangeType.DELETED);
		await until(() => index.stats.totalFiles === 2);
	});
	test('disabled indexing starts no watcher, reads or embedding; live toggles resume and stop it', async () => {
		let calls = 0;
		await set('ai.index.enabled', false);
		await start(async texts => { calls++; return vectors(texts); });
		await index.reindex(); change(join(first, 'same.ts'));
		assert.equal(watchers, 0); assert.equal(reads, 0); assert.equal(calls, 0);
		assert.equal((await index.search('SHARED', 5)).length, 2);
		await set('ai.index.enabled', true); await until(() => index.isReady);
		assert.equal(index.stats.totalFiles, 2); assert.equal(watchers, 2);
		await set('ai.index.enabled', false); assert.equal(watchers, 0); assert.equal(index.stats.state, 'disabled');
	});
	test('cancellation aborts in-flight embeddings, prevents commits and resumes; queued changes stay paused', async () => {
		let activeSignal: AbortSignal | undefined; let calls = 0; let blocked = true;
		await start(async (texts, signal) => { calls++; activeSignal = signal; return blocked ? new Promise(() => { }) : vectors(texts); }, false);
		await until(() => !!activeSignal);
		index.cancel(); assert.ok(activeSignal!.aborted);
		change(join(first, 'same.ts')); await new Promise(resolve => setTimeout(resolve, 350));
		assert.equal(calls, 1); assert.equal(index.stats.totalChunks, 0); assert.equal(index.stats.state, 'cancelled');
		blocked = false; await index.reindex();
		assert.equal(index.stats.state, 'idle'); assert.equal(index.stats.totalFiles, 2);
	});
	test('disabling during a request aborts it and leaves no late commits', async () => {
		let signal: AbortSignal | undefined;
		await start(async (_texts, current) => { signal = current; return new Promise(() => { }); }, false);
		await until(() => !!signal); await set('ai.index.enabled', false);
		assert.ok(signal!.aborted); assert.equal(index.stats.totalFiles, 0); assert.equal(watchers, 0);
	});
	test('large workspace caps files, batches across files and spaces requests', async () => {
		roots = [first]; await unlink(join(first, 'same.ts'));
		await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(join(first, `file-${String(i).padStart(3, '0')}.ts`), `value ${i}`)));
		await set('ai.index.maxFiles', 100); await set('ai.index.batchSize', 16); await set('ai.index.requestInterval', 30);
		const calls: { at: number; size: number }[] = [];
		await start(async texts => { calls.push({ at: Date.now(), size: texts.length }); return vectors(texts); });
		assert.equal(index.stats.totalFiles, 100); assert.equal(index.stats.limited, true);
		assert.equal(index.stats.processed, 100); assert.equal(index.stats.total, 100);
		assert.equal(calls.length, 7); assert.ok(calls.every(call => call.size <= 16));
		assert.ok(calls.slice(1).every((call, i) => call.at - calls[i].at >= 25));
		await index.reindex(); assert.equal(calls.length, 7);
	});
	test('excludes ignored, configured and sensitive files and escaped symlinks', async () => {
		roots = [first];
		await mkdir(join(first, '.git'));
		await writeFile(join(first, '.gitignore'), 'ignored.ts\n');
		for (const name of ['ignored.ts', 'excluded.ts', 'search.ts', '.env', 'private-secret.ts', 'custom.ts', 'note.md']) { await writeFile(join(first, name), name); }
		await writeFile(join(temp, 'outside.ts'), 'outside'); await symlink(join(temp, 'outside.ts'), join(first, 'linked.ts'));
		await set('files.exclude', { '**/excluded.ts': true }); await set('search.exclude', { '**/search.ts': true });
		await set('ai.index.exclude', ['**/custom.ts']); await set('ai.index.include', ['**/*.ts']);
		const inputs: string[] = [];
		await start(async texts => { inputs.push(...texts); return vectors(texts); });
		assert.equal(index.stats.totalFiles, 1); assert.deepEqual(inputs, ['SHARED first']);
		change(join(first, 'linked.ts'), FileChangeType.ADDED); change(join(first, '.env'));
		await index.indexFile(join(first, 'ignored.ts')); assert.deepEqual(inputs, ['SHARED first']);
		await writeFile(join(first, '.gitignore'), 'same.ts\nignored.ts\n'); change(join(first, '.gitignore'));
		await until(() => index.stats.totalFiles === 0);
	});
	test('failed embedding preserves committed entries and retries changed content', async () => {
		let fail = false;
		await start(async texts => { if (fail) { throw new Error('API unavailable'); } return vectors(texts); });
		await writeFile(join(first, 'same.ts'), 'replacement first'); fail = true;
		await index.indexFile(join(first, 'same.ts'));
		assert.equal(index.stats.state, 'error'); assert.equal(index.stats.totalChunks, 2);
		fail = false; await index.reindex();
		assert.equal(index.stats.state, 'idle');
		assert.ok((await index.search('first', 5)).some(hit => hit.content === 'replacement first'));
	});
	test('workspace removal disposes its watcher and removes search results', async () => {
		await start(vectors); roots = [first]; folders.fire({});
		await until(() => index.isReady); assert.equal(watchers, 1); assert.equal(index.stats.totalFiles, 1);
		assert.ok((await index.search('SHARED', 5)).every(hit => hit.filePath === 'same.ts'));
	});
});
