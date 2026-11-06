/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Index Builder
 *  Orchestrates full + incremental code indexing.
 *  Embeddings: primary path uses the configured AI model embedding API;
 *              falls back gracefully to keyword-only search when unavailable.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IAIModelService } from './aiModelService.js';
import { IndexedDB } from '../../../base/browser/indexedDB.js';
import { Sequencer, SequencerByKey } from '../../../base/common/async.js';
import { isEqualOrParent } from '../../../base/common/extpath.js';
import { resolve } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { IFileService, FileOperationResult, toFileOperationResult } from '../../files/common/files.js';
import { runIndexRipgrep } from './indexRipgrep.js';
import { IndexStore, type IndexedChunk } from '../common/indexStore.js';
import { chunkFile } from '../common/chunker.js';

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILE_LINES = 1000;

export class IndexBuilder extends Disposable {
	private store: IndexStore | null = null;
	private disposed = false;
	private embeddingAvailable = false;
	private readonly fileQueue = new SequencerByKey<string>();
	private readonly scanQueue = new Sequencer();

	constructor(
		readonly workspaceRoot: string,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IAIModelService private readonly modelService: IAIModelService,
	) { super(); }

	async initialize(): Promise<void> {
		let database: IndexedDB | undefined;
		if (typeof indexedDB !== 'undefined') {
			try {
				database = await IndexedDB.create('ai-studio-index:' + this.workspaceRoot, 1, ['files']);
			} catch (error) {
				this.logService.warn('[IndexBuilder] Workspace index will use memory', error);
			}
		}
		const browserDatabase = database;
		let store = new IndexStore(browserDatabase ? {
			getFiles: () => browserDatabase.getKeyValues('files', (value): value is IndexedChunk[] => Array.isArray(value)),
			replaceFile: async (filePath, entries) => {
				if (entries.length) {
					await browserDatabase.runInTransaction('files', 'readwrite', storage => storage.put(entries, filePath));
				} else {
					await browserDatabase.runInTransaction('files', 'readwrite', storage => storage.delete(filePath));
				}
			},
			close: () => browserDatabase.close(),
		} : undefined);
		if (!database && typeof process !== 'undefined' && process.versions?.node) {
			const { createNodeIndexStore } = await import('../node/indexStore.js');
			store = await createNodeIndexStore(this.workspaceRoot);
		}
		await store.initialize();
		if (this.disposed) { store.close(); return; }
		this.store = store;
		await this.checkEmbedding();
	}

	private async checkEmbedding(): Promise<void> {
		try {
			const [probe] = await this.modelService.embed(['test probe']);
			this.embeddingAvailable = !!probe?.some(value => value !== 0) && probe.every(Number.isFinite);
		} catch {
			this.logService.warn('[IndexBuilder] Embedding API unavailable - keyword-only search.');
		}
	}

	async fullIndex(retryEmbedding = false): Promise<void> {
		await this.scanQueue.queue(async () => {
			if (retryEmbedding && !this.disposed && !this.embeddingAvailable) { await this.checkEmbedding(); }
			if (!this.isReady() || !this.store) { return; }
			const files = await runIndexRipgrep(['--files', '--null', '--glob', '!**/node_modules/**', '--', '.'], this.workspaceRoot);
			const current = new Set(files.split('\0').filter(Boolean).map(path => resolve(this.workspaceRoot, path)));
			for (const indexed of [...this.store.filePaths]) {
				if (!current.has(indexed)) { await this.removeFile(indexed); }
			}
			for (const file of current) {
				if (this.disposed) { break; }
				await this.indexFile(file);
			}
		});
	}

	async indexFile(path: string): Promise<void> {
		const file = resolve(this.workspaceRoot, path);
		if (!this.contains(file)) { return; }
		await this.fileQueue.queue(file, async () => {
			if (!this.isReady() || !this.store) { return; }
			const entries: IndexedChunk[] = [];
			try {
				const { value } = await this.fileService.readFile(URI.file(file), { limits: { size: MAX_FILE_SIZE } });
				const text = value.toString();
				if (value.byteLength <= MAX_FILE_SIZE && !text.includes('\0') && text.split('\n').length <= MAX_FILE_LINES) {
					for (const chunk of chunkFile(file, text, _extToLang(file))) {
						entries.push({ chunk, embedding: await this.embed(chunk.content) });
					}
				}
			} catch (error) {
				if (this.disposed) { return; }
				const result = toFileOperationResult(error as Error);
				// A missing, oversized or changed file must not keep its previous searchable text.
				entries.length = 0;
				if (result !== FileOperationResult.FILE_NOT_FOUND && result !== FileOperationResult.FILE_TOO_LARGE) {
					this.logService.warn('[IndexBuilder] Cannot index ' + file, error);
				}
			}
			if (!this.disposed) { await this.store.replaceFile(file, entries); }
		});
	}

	async removeFile(path: string): Promise<void> {
		const file = resolve(this.workspaceRoot, path);
		if (this.contains(file)) {
			await this.fileQueue.queue(file, async () => {
				if (!this.disposed) { await this.store?.replaceFile(file, []); }
			});
		}
	}

	contains(file: string): boolean { return isEqualOrParent(file, this.workspaceRoot, !isLinux); }
	getStore(): IndexStore | null { return this.store; }
	isReady(): boolean { return !this.disposed && this.store !== null && this.embeddingAvailable; }

	async embed(text: string): Promise<Float32Array> {
		const [vector] = await this.modelService.embed([text]);
		if (!vector?.length || !vector.some(value => value !== 0) || !vector.every(Number.isFinite)) {
			throw new Error('Invalid embedding returned');
		}
		return new Float32Array(vector);
	}

	override dispose(): void {
		this.disposed = true;
		this.store?.close();
		super.dispose();
	}
}

function _extToLang(fp: string): string {
	const ext = fp.split('.').pop()?.toLowerCase() || '';
	const m: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', rb: 'ruby', };
	return m[ext] || ext;
}
