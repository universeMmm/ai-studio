/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { ILogService } from '../../log/common/log.js';
import { IAIModelService } from './aiModelService.js';
import { Sequencer } from '../../../base/common/async.js';
import { StringSHA1 } from '../../../base/common/hash.js';
import { match } from '../../../base/common/glob.js';
import { isEqualOrParent } from '../../../base/common/extpath.js';
import { relative, resolve } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { IFileService, FileOperationResult, toFileOperationResult } from '../../files/common/files.js';
import { runIndexRipgrep } from './indexRipgrep.js';
import { IndexStore, IndexMemoryLimitError, type IndexedChunk, type IndexFileMetadata } from '../common/indexStore.js';
import { chunkFile } from '../common/chunker.js';
import { isSensitiveFile } from '../common/sensitiveFiles.js';
import { abortable, indexDelay, yieldIndexTask } from '../common/indexCancellation.js';
import { createBrowserIndexStore } from './indexStorage.js';
import type { IndexOptions } from './indexOptions.js';
import type { ChunkedCode } from '../common/aiTypes.js';

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILE_LINES = 1000;
const MAX_BATCH_CHARACTERS = 32000;
interface PreparedFile { file: string; metadata: IndexFileMetadata; chunks: ChunkedCode[]; entries: IndexedChunk[] }

/** All scans and changes share a queue, so a late scan cannot resurrect a deleted file. */
export class IndexBuilder extends Disposable {
	private store: IndexStore | null = null;
	private disposed = false;
	private initialized = false;
	private embeddingAvailable = true;
	private controller = new AbortController();
	private readonly queue = new Sequencer();
	private candidates = new Set<string>();
	private canonicalRoot: string;
	private nextRequest = 0;
	readonly progress = { processed: 0, total: 0, limited: false, memoryLimited: false };

	constructor(
		readonly workspaceRoot: string,
		readonly options: IndexOptions,
		private readonly changed: () => void,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IAIModelService private readonly modelService: IAIModelService,
	) { super(); this.canonicalRoot = workspaceRoot; }

	async initialize(): Promise<void> {
		let store: IndexStore | undefined;
		const maxBytes = this.options.maxMemoryMB * 1024 * 1024;
		if (typeof indexedDB !== 'undefined') {
			try { store = await createBrowserIndexStore(this.workspaceRoot, maxBytes); }
			catch (error) { this.logService.warn('[IndexBuilder] Workspace index will use memory', error); }
		}
		if (!store && typeof process !== 'undefined' && process.versions?.node) {
			const { createNodeIndexStore } = await import('../node/indexStore.js');
			store = await createNodeIndexStore(this.workspaceRoot, maxBytes);
		}
		store ??= new IndexStore(undefined, undefined, maxBytes);
		this.store = store;
		try {
			await store.initialize(this.signal, () => this.changed(), record => this.accepts(record.filePath) && record.metadata?.embeddingKey === this.options.embeddingKey);
			this.progress.memoryLimited = store.memory.limited;
			if (this.disposed) { store.close(); return; }
			this.canonicalRoot = (await abortable(this.fileService.realpath(URI.file(this.workspaceRoot)), this.signal))?.fsPath ?? this.workspaceRoot;
			this.initialized = true;
		} catch (error) { store.close(); if (this.store === store) { this.store = null; } throw error; }
	}

	get signal(): AbortSignal { return this.controller.signal; }
	cancel(): void { this.controller.abort(); }
	resume(): void {
		if (!this.disposed) {
			if (this.signal.aborted) { this.controller = new AbortController(); }
			this.embeddingAvailable = true;
		}
	}
	contains(file: string): boolean { return isEqualOrParent(file, this.workspaceRoot, !isLinux); }
	accepts(path: string): boolean {
		const file = resolve(this.workspaceRoot, path);
		const name = relative(this.workspaceRoot, file).replace(/\\/g, '/');
		return !this.excludes(file) && this.options.include.some(pattern => match(pattern, name));
	}
	excludes(path: string): boolean {
		const file = resolve(this.workspaceRoot, path);
		const name = relative(this.workspaceRoot, file).replace(/\\/g, '/');
		return !this.contains(file) || isSensitiveFile(name) || this.options.exclude.some(pattern => match(pattern, name) || match(pattern, name + '/__index_child__'));
	}
	getStore(): IndexStore | null { return this.store; }
	get candidateCount(): number { return this.candidates.size; }
	isReady(): boolean { return this.initialized && !this.disposed && !this.signal.aborted && this.embeddingAvailable; }

	fullIndex(): Promise<void> {
		const signal = this.signal;
		return this.queue.queue(async () => {
			signal.throwIfAborted();
			if (!this.initialized || !this.store) { return; }
			this.progress.processed = 0;
			this.progress.total = 0;
			this.changed();
			const args = ['--files', '--null', '--hidden'];
			for (const pattern of this.options.exclude) { args.push('--glob', '!' + pattern); }
			args.push('--', '.');
			const files = await runIndexRipgrep(args, this.workspaceRoot, signal);
			const all: string[] = [];
			let start = 0, visited = 0;
			for (let end = files.indexOf('\0'); end >= 0; end = files.indexOf('\0', start)) {
				const path = resolve(this.workspaceRoot, files.slice(start, end));
				if (this.accepts(path)) { all.push(path); }
				start = end + 1;
				if (++visited % 256 === 0) { await yieldIndexTask(signal); }
			}
			// Sort bounded runs, then merge with yields so a 100k-file listing remains cancellable.
			await sortPaths(all, signal);
			this.progress.limited = all.length > this.options.maxFiles;
			this.candidates = new Set(all.slice(0, this.options.maxFiles));
			this.progress.total = this.candidates.size;
			for (const indexed of this.store.filePaths) {
				signal.throwIfAborted();
				if (!this.candidates.has(indexed)) { await this.store.removeFile(indexed); }
			}
			this.progress.memoryLimited = false;
			await this.processFiles([...this.candidates], signal);
		});
	}

	/** New files require enumeration to respect gitignore and the workspace file limit. */
	indexFile(path: string): Promise<void> { return this.updateFiles([path]); }
	updateFiles(paths: string[]): Promise<void> {
		const files = paths.map(path => resolve(this.workspaceRoot, path)).filter(path => this.accepts(path));
		if (files.some(file => !this.candidates.has(file))) { return this.fullIndex(); }
		const signal = this.signal;
		return this.queue.queue(async () => {
			signal.throwIfAborted();
			this.progress.total = files.length;
			this.progress.processed = 0;
			await this.processFiles(files, signal, true);
		});
	}

	private async processFiles(files: string[], signal: AbortSignal, forceRead = false): Promise<void> {
		let pending: PreparedFile[] = [];
		let chunks = 0;
		let characters = 0;
		let visited = 0;
		let limited = false;
		const flush = async () => {
			if (!pending.length) { return; }
			const entries = pending.flatMap(file => file.chunks.map(chunk => ({ owner: file, chunk })));
			for (let start = 0; start < entries.length;) {
				let end = start;
				let size = 0;
				while (end < entries.length && end - start < this.options.batchSize && size + entries[end].chunk.content.length <= MAX_BATCH_CHARACTERS) { size += entries[end++].chunk.content.length; }
				const batch = entries.slice(start, end);
				const vectors = await this.embedBatch(batch.map(entry => entry.chunk.content), signal);
				batch.forEach(({ owner, chunk }, i) => owner.entries.push({ chunk, embedding: new Float32Array(vectors[i]) }));
				start = end;
			}
			for (const file of pending) {
				signal.throwIfAborted();
				// Do not publish a version read while the file was being edited.
				const stat = await abortable(this.fileService.stat(URI.file(file.file)), signal);
				signal.throwIfAborted();
				if (stat.mtime === file.metadata.mtime && stat.size === file.metadata.size) {
					try { await this.store!.replaceFile(file.file, file.entries, file.metadata); }
					catch (error) {
						if (!(error instanceof IndexMemoryLimitError)) { throw error; }
						this.progress.memoryLimited = limited = true;
						this.changed(); break;
					}
				}
				this.progress.processed++;
				this.changed();
			}
			pending = []; chunks = 0; characters = 0;
		};
		for (const file of files) {
			signal.throwIfAborted();
			const prepared = await this.prepareFile(file, signal, forceRead);
			if (prepared) {
				pending.push(prepared);
				chunks += prepared.chunks.length;
				characters += prepared.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
				if (chunks >= this.options.batchSize || characters >= MAX_BATCH_CHARACTERS || pending.length >= this.options.batchSize) { await flush(); }
			} else { this.progress.processed++; this.changed(); }
			if (limited) { break; }
			if (++visited % 64 === 0) { await yieldIndexTask(signal); }
		}
		await flush();
	}

	private async prepareFile(file: string, signal: AbortSignal, forceRead: boolean): Promise<PreparedFile | undefined> {
		const store = this.store!;
		const uri = URI.file(file);
		const source = new CancellationTokenSource();
		const cancel = () => source.cancel();
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const stat = await abortable(this.fileService.stat(uri), signal);
			signal.throwIfAborted();
			if (!stat.isFile || stat.isSymbolicLink) { await store.removeFile(file); return; }
			const previous = store.getMetadata(file);
			if (!forceRead && previous?.embeddingKey === this.options.embeddingKey && previous.mtime === stat.mtime && previous.size === stat.size && (previous.text !== undefined || stat.size > MAX_FILE_SIZE)) { return; }
			const canonical = await abortable(this.fileService.realpath(uri), signal);
			signal.throwIfAborted();
			if (canonical && (!isEqualOrParent(canonical.fsPath, this.canonicalRoot, !isLinux) || isSensitiveFile(relative(this.canonicalRoot, canonical.fsPath)))) { await store.removeFile(file); return; }
			const metadata: IndexFileMetadata = { mtime: stat.mtime, size: stat.size, hash: '', embeddingKey: this.options.embeddingKey };
			if (stat.size > MAX_FILE_SIZE) { return { file, metadata, chunks: [], entries: [] }; }
			const { value } = await abortable(this.fileService.readFile(uri, { limits: { size: MAX_FILE_SIZE } }, source.token), signal);
			signal.throwIfAborted();
			const text = value.toString();
			// Preserve headers/comments as well as embedding chunks. Legacy records
			// acquire text on their next scan without another embedding request.
			if (!text.includes('\0')) { metadata.text = text; }
			const hash = new StringSHA1(); hash.update(text); metadata.hash = hash.digest();
			if (previous?.embeddingKey === metadata.embeddingKey && previous.hash === metadata.hash) {
				return { file, metadata, chunks: [], entries: store.getChunks(file) };
			}
			const lines = text.split('\n');
			const valid = value.byteLength <= MAX_FILE_SIZE && !text.includes('\0') && lines.length <= MAX_FILE_LINES && lines.every(line => line.length <= 8000);
			const chunks = valid && text.trim() ? chunkFile(file, text, extToLang(file)).flatMap(chunk => splitChunk(chunk)) : [];
			return { file, metadata, chunks, entries: [] };
		} catch (error) {
			signal.throwIfAborted();
			const result = toFileOperationResult(error as Error);
			if (result === FileOperationResult.FILE_NOT_FOUND || result === FileOperationResult.FILE_TOO_LARGE) { await store.removeFile(file); return; }
			throw error; // Keep the last committed fingerprint so failures are retried.
		} finally { signal.removeEventListener('abort', cancel); source.dispose(); }
	}

	private async embedBatch(texts: string[], signal: AbortSignal): Promise<number[][]> {
		signal.throwIfAborted();
		if (!this.embeddingAvailable) { throw new Error('Embedding unavailable; update index to retry'); }
		await indexDelay(Math.max(0, this.nextRequest - Date.now()), signal);
		const request = new AbortController();
		const abort = () => request.abort(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		const timeout = setTimeout(() => request.abort(new Error('Embedding request timed out')), 30000);
		try {
			this.nextRequest = Date.now() + this.options.requestInterval;
			const vectors = await abortable(this.modelService.embed(texts, request.signal), request.signal);
			if (vectors.length !== texts.length || vectors.some(vector => !vector?.length || vector.length !== vectors[0].length || !vector.some(value => value !== 0) || !vector.every(Number.isFinite))) { throw new Error('Invalid embedding returned'); }
			return vectors;
		} catch (error) { if (!signal.aborted) { this.embeddingAvailable = false; } throw error; }
		finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
	}

	async embed(text: string, signal: AbortSignal = this.signal): Promise<Float32Array> { return new Float32Array((await this.embedBatch([text], signal))[0]); }

	removeFile(path: string): Promise<void> {
		const file = resolve(this.workspaceRoot, path);
		const signal = this.signal;
		return this.queue.queue(async () => {
			signal.throwIfAborted();
			if (!this.contains(file) || !this.store) { return; }
			for (const indexed of this.store.filePaths) {
				if (isEqualOrParent(indexed, file, !isLinux)) { signal.throwIfAborted(); await this.store.removeFile(indexed); this.candidates.delete(indexed); }
			}
			this.changed();
		});
	}

	override dispose(): void { this.disposed = true; this.cancel(); this.store?.close(); super.dispose(); }
}

function extToLang(fp: string): string {
	const ext = fp.split('.').pop()?.toLowerCase() || '';
	const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', rb: 'ruby' };
	return languages[ext] || ext;
}

/** Bound both individual inputs and the total request size, including long module chunks. */
function splitChunk(chunk: ChunkedCode): ChunkedCode[] {
	const chunks: ChunkedCode[] = [];
	let lines: string[] = [];
	let size = 0;
	let startLine = chunk.startLine;
	const flush = () => {
		if (!lines.length) { return; }
		// A path/line key cannot collide across files as the chunker's legacy 32-bit hash can.
		chunks.push({ ...chunk, id: chunk.filePath + ':' + startLine, startLine, endLine: startLine + lines.length - 1, content: lines.join('\n') });
		startLine += lines.length; lines = []; size = 0;
	};
	for (const line of chunk.content.split('\n')) {
		if (size + line.length + 1 > 8000) { flush(); }
		lines.push(line); size += line.length + 1;
	}
	flush();
	return chunks;
}

async function sortPaths(paths: string[], signal: AbortSignal): Promise<void> {
	const run = 2048;
	for (let start = 0; start < paths.length; start += run) {
		const sorted = paths.slice(start, start + run).sort();
		for (let i = 0; i < sorted.length; i++) { paths[start + i] = sorted[i]; }
		await yieldIndexTask(signal);
	}
	let source = paths, target = new Array<string>(paths.length);
	for (let width = run; width < paths.length; width *= 2) {
		for (let start = 0; start < paths.length; start += width * 2) {
			let left = start, right = Math.min(start + width, paths.length);
			const mid = right, end = Math.min(start + width * 2, paths.length);
			for (let i = start; i < end; i++) {
				target[i] = left < mid && (right >= end || source[left] <= source[right]) ? source[left++] : source[right++];
				if (i % 4096 === 0) { await yieldIndexTask(signal); }
			}
		}
		[source, target] = [target, source];
	}
	if (source !== paths) { for (let i = 0; i < paths.length; i++) { paths[i] = source[i]; } }
}
