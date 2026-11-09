/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace vector index
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';
import { abortable, yieldIndexTask } from './indexCancellation.js';
import type { ChunkedCode, CodeSnippet } from './aiTypes.js';

export interface IndexedChunk {
	chunk: ChunkedCode;
	embedding: Float32Array;
}

export interface IndexFileMetadata {
	mtime: number;
	size: number;
	hash: string;
	embeddingKey: string;
}

export function isIndexFileMetadata(value: unknown): value is IndexFileMetadata {
	if (!value || typeof value !== 'object') { return false; }
	const stamp = value as IndexFileMetadata;
	return Number.isFinite(stamp.mtime) && Number.isFinite(stamp.size) && typeof stamp.hash === 'string' && typeof stamp.embeddingKey === 'string';
}

export interface IndexFileRecord {
	filePath: string;
	entries: IndexedChunk[];
	metadata?: IndexFileMetadata;
}

export class IndexMemoryLimitError extends Error {
	constructor() { super('Index memory limit reached'); }
}

export interface IIndexStorage {
	scanFiles?(signal?: AbortSignal): AsyncIterable<IndexFileRecord>;
	getFiles?(): Promise<Map<string, IndexedChunk[]>>;
	getMetadata?(): Promise<Map<string, IndexFileMetadata>>;
	replaceFile(filePath: string, entries: IndexedChunk[], metadata?: IndexFileMetadata): Promise<void>;
	close(): void | Promise<void>;
}

export interface NearestNeighbors {
	initIndex(capacity: number): void;
	addPoint(vector: number[], label: number): void;
	searchKnn(vector: number[], count: number): { neighbors: number[]; distances: number[] };
}

export type HnswConstructor = new (space: 'cosine', dimensions: number) => NearestNeighbors;
type Hit = { chunk: CodeSnippet; score: number };

export class IndexStore {
	private readonly files = new Map<string, IndexedChunk[]>();
	private readonly metadata = new Map<string, IndexFileMetadata>();
	private totalChunks = 0;
	private totalBytes = 0;
	private memoryLimited = false;
	private readonly footprints = new Map<string, number>();
	private norms = new WeakMap<Float32Array, number>();
	private readonly writes = new Sequencer();
	private closed = false;
	private closing?: Promise<void>;
	private revision = 0;
	private neighbors?: { index: NearestNeighbors; entries: IndexedChunk[]; dimension: number };

	constructor(private readonly storage?: IIndexStorage, private Hnsw?: HnswConstructor, private readonly maxBytes = Number.POSITIVE_INFINITY) { }

	async initialize(signal?: AbortSignal, progress?: () => void, accept?: (record: IndexFileRecord) => boolean): Promise<void> {
		let visited = 0;
		const load = async ({ filePath, entries, metadata }: IndexFileRecord) => {
			signal?.throwIfAborted();
			if (this.closed) { return; }
			const bytes = this.estimateBytes(filePath, entries, metadata);
			if (accept && !accept({ filePath, entries, metadata })) {
				await this.storage?.replaceFile(filePath, []);
			} else if (this.totalBytes + bytes > this.maxBytes) {
				this.memoryLimited = true;
				// A lowered budget also trims persisted vectors, so restart cannot bypass it.
				await this.storage?.replaceFile(filePath, []);
			} else { this.adopt(filePath, entries, metadata, bytes); }
			if (++visited % 128 === 0) { progress?.(); await yieldIndexTask(signal); }
		};
		if (this.storage?.scanFiles) {
			for await (const record of this.storage.scanFiles(signal)) { await load(record); }
		} else {
			const files = await abortable(this.storage?.getFiles?.() ?? Promise.resolve(new Map<string, IndexedChunk[]>()), signal);
			const metadata = await abortable(this.storage?.getMetadata?.() ?? Promise.resolve(new Map<string, IndexFileMetadata>()), signal);
			for (const [filePath, entries] of files) { await load({ filePath, entries, metadata: metadata.get(filePath) }); }
			for (const [filePath, stamp] of metadata) { if (!files.has(filePath)) { await load({ filePath, entries: [], metadata: stamp }); } }
		}
	}

	get filePaths(): IterableIterator<string> { return this.paths(); }
	private *paths(): IterableIterator<string> {
		yield* this.metadata.keys();
		for (const file of this.files.keys()) { if (!this.metadata.has(file)) { yield file; } }
	}
	get memory(): { bytes: number; limit: number; limited: boolean } { return { bytes: this.totalBytes, limit: this.maxBytes, limited: this.memoryLimited }; }

	getMetadata(path: string): IndexFileMetadata | undefined { return this.metadata.get(path); }
	getChunks(path: string): IndexedChunk[] { return this.files.get(path) ?? []; }

	add(id: string, chunk: Omit<ChunkedCode, 'id'>, embedding: Float32Array): Promise<void> {
		return this.writes.queue(() => {
			const entries = (this.files.get(chunk.filePath) ?? []).filter(entry => entry.chunk.id !== id);
			entries.push({ chunk: { ...chunk, id }, embedding });
			return this.commitFile(chunk.filePath, entries);
		});
	}

	removeFile(filePath: string): Promise<void> { return this.replaceFile(filePath, []); }

	replaceFile(filePath: string, entries: IndexedChunk[], metadata?: IndexFileMetadata): Promise<void> {
		return this.writes.queue(() => this.commitFile(filePath, entries, metadata));
	}

	private async commitFile(filePath: string, entries: IndexedChunk[], metadata?: IndexFileMetadata): Promise<void> {
		if (this.closed || (!metadata && !entries.length && !this.files.has(filePath) && !this.metadata.has(filePath))) { return; }
		const bytes = this.estimateBytes(filePath, entries, metadata);
		if (this.totalBytes - (this.footprints.get(filePath) ?? 0) + bytes > this.maxBytes) {
			this.memoryLimited = true;
			throw new IndexMemoryLimitError();
		}
		await this.storage?.replaceFile(filePath, entries, metadata);
		this.adopt(filePath, entries, metadata, bytes);
	}

	private estimateBytes(path: string, entries: IndexedChunk[], metadata?: IndexFileMetadata): number {
		if (!entries.length && !metadata) { return 0; }
		// Conservative retained-payload accounting, not a claim about total process RSS.
		let bytes = 256 + path.length * 2 + (metadata ? 128 + (metadata.hash.length + metadata.embeddingKey.length) * 2 : 0);
		for (const { chunk, embedding } of entries) { bytes += embedding.byteLength + 256 + 2 * (chunk.id.length + chunk.content.length + chunk.name.length); }
		return bytes;
	}

	private adopt(filePath: string, entries: IndexedChunk[], metadata: IndexFileMetadata | undefined, bytes: number): void {
		this.revision++;
		this.totalChunks += entries.length - (this.files.get(filePath)?.length ?? 0);
		this.totalBytes += bytes - (this.footprints.get(filePath) ?? 0);
		if (bytes) { this.footprints.set(filePath, bytes); } else { this.footprints.delete(filePath); }
		if (metadata) { this.metadata.set(filePath, metadata); } else { this.metadata.delete(filePath); }
		if (entries.length) {
			this.files.set(filePath, entries);
			for (const { embedding } of entries) {
				if (!this.norms.has(embedding)) {
					let norm = 0; for (let i = 0; i < embedding.length; i++) { norm += embedding[i] * embedding[i]; }
					this.norms.set(embedding, Math.sqrt(norm));
				}
			}
		} else { this.files.delete(filePath); }
		this.neighbors = undefined;
	}

	async searchSemantic(query: Float32Array, topK: number, signal?: AbortSignal): Promise<Hit[]> {
		signal?.throwIfAborted();
		if (topK <= 0 || query.length === 0) { return []; }
		// Building a large native graph here doubles vector memory and blocks cancellation.
		// Keep this optional accelerator for small indexes; large exact scans stay cooperative.
		if (this.Hnsw && this.totalChunks <= 2048 && this.totalBytes <= 8 * 1024 * 1024) {
			try {
				if (this.neighbors?.dimension !== query.length) {
					const revision = this.revision;
					const entries = Array.from(this.files.values()).flat().filter(entry => entry.embedding.length === query.length);
					if (!entries.length) { return []; }
					const index = new this.Hnsw('cosine', query.length);
					index.initIndex(entries.length);
					for (let i = 0; i < entries.length; i++) {
						if (i % 16 === 0) { await yieldIndexTask(signal); }
						if (revision !== this.revision || this.closed) { throw new Error('Index changed while constructing accelerator'); }
						index.addPoint(Array.from(entries[i].embedding), i);
					}
					this.neighbors = { dimension: query.length, entries, index };
				}
				const { entries, index } = this.neighbors;
				const result = index.searchKnn(Array.from(query), Math.min(topK, entries.length));
				return result.neighbors.map((label, i) => this.hit(entries[label], 1 / (1 + result.distances[i])));
			} catch {
				signal?.throwIfAborted();
				this.Hnsw = undefined;
				this.neighbors = undefined;
			}
		}
		const results: Hit[] = [];
		const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
		if (!queryNorm) { return []; }
		let visited = 0;
		let deadline = performance.now() + 8;
		for (const chunks of this.files.values()) {
			for (const entry of chunks) {
				if (++visited % 32 === 0 && performance.now() >= deadline) { await yieldIndexTask(signal); deadline = performance.now() + 8; }
				if (this.closed) { return []; }
				const vector = entry.embedding;
				if (vector.length !== query.length) { continue; }
				let dot = 0;
				const norm = this.norms.get(vector) ?? 0;
				for (let i = 0; i < query.length; i++) {
					dot += query[i] * vector[i];
				}
				if (norm) {
					const cosine = Math.max(-1, Math.min(1, dot / (queryNorm * norm)));
					const score = 1 / (2 - cosine);
					if (results.length < topK || score > results[results.length - 1].score) {
						results.push(this.hit(entry, score));
						results.sort((a, b) => b.score - a.score);
						if (results.length > topK) { results.pop(); }
					}
				}
			}
		}
		signal?.throwIfAborted();
		return results.sort((a, b) => b.score - a.score).slice(0, topK);
	}

	private hit({ chunk }: IndexedChunk, score: number): Hit {
		const { filePath, startLine, endLine, content } = chunk;
		return { chunk: { filePath, startLine, endLine, content, score }, score };
	}

	async getStats(): Promise<{ totalFiles: number; totalChunks: number }> { return this.stats; }

	get stats(): { totalFiles: number; totalChunks: number } {
		return { totalFiles: this.files.size, totalChunks: this.totalChunks };
	}

	close(): Promise<void> {
		if (this.closing) { return this.closing; }
		this.closed = true;
		this.closing = this.writes.queue(async () => {
			this.files.clear();
			this.metadata.clear();
			this.totalChunks = 0;
			this.totalBytes = 0;
			this.footprints.clear();
			this.norms = new WeakMap();
			this.neighbors = undefined;
			await this.storage?.close();
		});
		// Disposable callers may not await shutdown. Awaiting callers still receive
		// the rejection and can report a native database close failure.
		void this.closing.catch(() => { });
		return this.closing;
	}

}
