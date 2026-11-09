/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { IndexStore, type HnswConstructor, type IIndexStorage, type IndexedChunk, isIndexFileMetadata } from '../common/indexStore.js';
import { abortable } from '../common/indexCancellation.js';
import type { ChunkedCode } from '../common/aiTypes.js';

interface StoredRow {
	id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	content: string;
	kind: ChunkedCode['kind'];
	name: string;
	embedding: Uint8Array;
}

/** Native persistence stays outside the browser/common index implementation. */
export async function createNodeIndexStore(workspaceRoot: string, maxBytes = Number.POSITIVE_INFINITY): Promise<IndexStore> {
	let database: Database | undefined;
	let storage: IIndexStorage | undefined;
	try {
		const { default: sqlite3 } = await import('@vscode/sqlite3');
		const { mkdir } = await import('fs/promises');
		await mkdir(workspaceRoot + '/.ai-studio', { recursive: true });
		database = await new Promise<Database>((resolve, reject) => {
			const db = new sqlite3.Database(workspaceRoot + '/.ai-studio/index.db', error => error ? reject(error) : resolve(db));
		});
		const db = database;
		const run = (sql: string, params: unknown[] = []): Promise<void> => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
		await run('CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, file_path TEXT, start_line INTEGER, end_line INTEGER, content TEXT, kind TEXT, name TEXT, embedding BLOB)');
		await run('CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path)');
		await run('CREATE TABLE IF NOT EXISTS index_files (file_path TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
		// Give legacy chunk-only files a paging key. Their absent fingerprint will be rebuilt.
		await run("INSERT OR IGNORE INTO index_files SELECT DISTINCT file_path, '{}' FROM chunks");
		const all = async <T>(sql: string, params: unknown[], signal?: AbortSignal): Promise<T[]> => {
			signal?.throwIfAborted();
			const abort = () => db.interrupt();
			signal?.addEventListener('abort', abort, { once: true });
			try {
				return await abortable(new Promise<T[]>((resolve, reject) => db.all(sql, params, (error: Error | null, rows: T[]) => error ? reject(error) : resolve(rows))), signal);
			} finally { signal?.removeEventListener('abort', abort); }
		};
		storage = {
			async *scanFiles(signal) {
				let after = '';
				while (true) {
					const records = await all<{ file_path: string; metadata: string }>('SELECT * FROM index_files WHERE file_path > ? ORDER BY file_path LIMIT 16', [after], signal);
					if (!records.length) { return; }
					const rows = await all<StoredRow>(`SELECT * FROM chunks WHERE file_path IN (${records.map(() => '?').join(',')})`, records.map(record => record.file_path), signal);
					const files = new Map<string, IndexedChunk[]>();
					for (const row of rows) {
						const entries = files.get(row.file_path) ?? [];
						entries.push({ chunk: { id: row.id, filePath: row.file_path, startLine: row.start_line, endLine: row.end_line, content: row.content, kind: row.kind, name: row.name }, embedding: new Float32Array(Uint8Array.from(row.embedding).buffer) });
						files.set(row.file_path, entries);
					}
					for (const record of records) {
						signal?.throwIfAborted();
						const stamp: unknown = JSON.parse(record.metadata);
						yield { filePath: record.file_path, entries: files.get(record.file_path) ?? [], metadata: isIndexFileMetadata(stamp) ? stamp : undefined };
					}
					after = records[records.length - 1].file_path;
				}
			},
			replaceFile: async (filePath, entries, stamp) => {
				await run('BEGIN IMMEDIATE');
				try {
					await run('DELETE FROM chunks WHERE file_path = ?', [filePath]);
					await run('DELETE FROM index_files WHERE file_path = ?', [filePath]);
					if (stamp) { await run('INSERT INTO index_files VALUES (?,?)', [filePath, JSON.stringify(stamp)]); }
					for (const { chunk, embedding } of entries) {
						await run('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?)', [
							chunk.id, filePath, chunk.startLine, chunk.endLine, chunk.content, chunk.kind, chunk.name,
							Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
						]);
					}
					await run('COMMIT');
				} catch (error) {
					await run('ROLLBACK');
					throw error;
				}
			},
			close: () => new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())),
		};
	} catch {
		database?.close();
	}
	let Hnsw: HnswConstructor | undefined;
	try {
		// @ts-expect-error Optional native accelerator has no bundled declaration.
		const { default: hnsw } = await import('hnswlib-node');
		Hnsw = hnsw.HierarchicalNSW;
	} catch { /* Exact cosine search works without native modules. */ }
	return new IndexStore(storage, Hnsw, maxBytes);
}
