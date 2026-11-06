/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace vector index
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';
import type { ChunkedCode, CodeSnippet } from './aiTypes.js';

export interface IndexedChunk {
	chunk: ChunkedCode;
	embedding: Float32Array;
}

export interface IIndexStorage {
	getFiles(): Promise<Map<string, IndexedChunk[]>>;
	replaceFile(filePath: string, entries: IndexedChunk[]): Promise<void>;
	close(): void;
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
	private readonly writes = new Sequencer();
	private closed = false;
	private neighbors?: { index: NearestNeighbors; entries: IndexedChunk[]; dimension: number };

	constructor(private readonly storage?: IIndexStorage, private Hnsw?: HnswConstructor) { }

	async initialize(): Promise<void> {
		const files = await this.storage?.getFiles();
		for (const [path, chunks] of files ?? []) {
			this.files.set(path, chunks);
		}
	}

	get filePaths(): IterableIterator<string> { return this.files.keys(); }

	add(id: string, chunk: Omit<ChunkedCode, 'id'>, embedding: Float32Array): Promise<void> {
		return this.writes.queue(() => {
			const entries = (this.files.get(chunk.filePath) ?? []).filter(entry => entry.chunk.id !== id);
			entries.push({ chunk: { ...chunk, id }, embedding });
			return this.commitFile(chunk.filePath, entries);
		});
	}

	removeFile(filePath: string): Promise<void> { return this.replaceFile(filePath, []); }

	replaceFile(filePath: string, entries: IndexedChunk[]): Promise<void> {
		return this.writes.queue(() => this.commitFile(filePath, entries));
	}

	private async commitFile(filePath: string, entries: IndexedChunk[]): Promise<void> {
		if (this.closed || (!entries.length && !this.files.has(filePath))) { return; }
		await this.storage?.replaceFile(filePath, entries);
		if (entries.length) {
			this.files.set(filePath, entries);
		} else {
			this.files.delete(filePath);
		}
		this.neighbors = undefined;
	}

	async searchSemantic(query: Float32Array, topK: number): Promise<Hit[]> {
		if (topK <= 0 || query.length === 0) { return []; }
		if (this.Hnsw) {
			try {
				if (this.neighbors?.dimension !== query.length) {
					const entries = Array.from(this.files.values()).flat().filter(entry => entry.embedding.length === query.length);
					if (!entries.length) { return []; }
					const index = new this.Hnsw('cosine', query.length);
					index.initIndex(entries.length);
					entries.forEach((entry, i) => index.addPoint(Array.from(entry.embedding), i));
					this.neighbors = { dimension: query.length, entries, index };
				}
				const { entries, index } = this.neighbors;
				const result = index.searchKnn(Array.from(query), Math.min(topK, entries.length));
				return result.neighbors.map((label, i) => this.hit(entries[label], 1 / (1 + result.distances[i])));
			} catch {
				this.Hnsw = undefined;
				this.neighbors = undefined;
			}
		}
		const results: Hit[] = [];
		const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
		if (!queryNorm) { return []; }
		for (const chunks of this.files.values()) {
			for (const entry of chunks) {
				const vector = entry.embedding;
				if (vector.length !== query.length) { continue; }
				let dot = 0;
				let squaredNorm = 0;
				for (let i = 0; i < query.length; i++) {
					dot += query[i] * vector[i];
					squaredNorm += vector[i] * vector[i];
				}
				if (squaredNorm) {
					const cosine = Math.max(-1, Math.min(1, dot / (queryNorm * Math.sqrt(squaredNorm))));
					results.push(this.hit(entry, 1 / (2 - cosine)));
				}
			}
		}
		return results.sort((a, b) => b.score - a.score).slice(0, topK);
	}

	private hit({ chunk }: IndexedChunk, score: number): Hit {
		const { filePath, startLine, endLine, content } = chunk;
		return { chunk: { filePath, startLine, endLine, content, score }, score };
	}

	async getStats(): Promise<{ totalFiles: number; totalChunks: number }> { return this.stats; }

	get stats(): { totalFiles: number; totalChunks: number } {
		let totalChunks = 0;
		for (const entries of this.files.values()) { totalChunks += entries.length; }
		return { totalFiles: this.files.size, totalChunks };
	}

	close(): void {
		if (this.closed) { return; }
		this.closed = true;
		void this.writes.queue(async () => {
			this.storage?.close();
			this.files.clear();
			this.neighbors = undefined;
		});
	}

}
