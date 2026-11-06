/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { IndexStore, type HnswConstructor, type IIndexStorage, type IndexedChunk } from '../common/indexStore.js';
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
export async function createNodeIndexStore(workspaceRoot: string): Promise<IndexStore> {
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
		const rows = await new Promise<StoredRow[]>((resolve, reject) => {
			db.all('SELECT * FROM chunks', (error: Error | null, rows: StoredRow[]) => error ? reject(error) : resolve(rows));
		});
		const files = new Map<string, IndexedChunk[]>();
		for (const row of rows) {
			const chunks = files.get(row.file_path) ?? [];
			chunks.push({
				chunk: { id: row.id, filePath: row.file_path, startLine: row.start_line, endLine: row.end_line, content: row.content, kind: row.kind, name: row.name },
				embedding: new Float32Array(Uint8Array.from(row.embedding).buffer),
			});
			files.set(row.file_path, chunks);
		}
		storage = {
			getFiles: async () => files,
			replaceFile: async (filePath, entries) => {
				await run('BEGIN IMMEDIATE');
				try {
					await run('DELETE FROM chunks WHERE file_path = ?', [filePath]);
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
			close: () => { db.close(); },
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
	return new IndexStore(storage, Hnsw);
}
