/*---------------------------------------------------------------------------------------------
 *  AI Studio — Index Store
 *  SQLite persistence + in-memory HNSW vector index (384-dim).
 *  Degrades gracefully when native modules are unavailable.
 *--------------------------------------------------------------------------------------------*/

import type { ChunkedCode, CodeSnippet } from './aiTypes.js';
import { bufferToFloat32Array } from './byteUtils.js';

export class IndexStore {
	private _db: any = null;
	private _hnsw: any = null;
	private _hnswLib: any = null;
	private readonly _dim = 384;
	private readonly _maxElements = 50000;
	private readonly _dbPath: string;
	private _dirty = false;

	constructor(workspaceRoot: string) { this._dbPath = workspaceRoot + '/.ai-studio/index.db'; }

	async initialize(): Promise<void> {
		try {
			const sqlite3: any = await import('@vscode/sqlite3');
			// @ts-ignore: optional native module
      this._hnswLib = await import('hnswlib-node');

			this._db = await new Promise<any>((resolve, reject) => {
				const db = new sqlite3.default.Database(this._dbPath, (err: any) => err ? reject(err) : resolve(db));
			});
			this._db.exec(`CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, file_path TEXT, start_line INTEGER, end_line INTEGER, content TEXT, kind TEXT, name TEXT, embedding BLOB); CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);`);

			this._hnsw = new this._hnswLib.HierarchicalNSW('cosine', this._dim);
			this._hnsw.initIndex(this._maxElements);
			await this._restoreFromDb();
		} catch { /* degraded — keyword-only search still works */ }
	}

	private async _restoreFromDb(): Promise<void> {
		if (!this._db || !this._hnsw) return;
		const rows = await this._all('SELECT embedding FROM chunks ORDER BY rowid');
		let i = 0;
		for (const row of rows) { this._hnsw.addPoint(bufferToFloat32Array(row.embedding, this._dim), i++); }
	}

	async add(id: string, chunk: Omit<ChunkedCode, 'id'>, embedding: Float32Array): Promise<void> {
		if (!this._db) return;
		await this._run('INSERT OR REPLACE INTO chunks (id, file_path, start_line, end_line, content, kind, name, embedding) VALUES (?,?,?,?,?,?,?,?)', [id, chunk.filePath, chunk.startLine, chunk.endLine, chunk.content, chunk.kind, chunk.name, Buffer.from(embedding.buffer)]);
		if (this._hnsw) this._hnsw.addPoint(embedding, this._hnsw.getCurrentCount());
		// Do NOT reset _dirty here — if removeFile() was called before add(),
		// the HNSW index still has stale entries that searchSemantic must rebuild.
	}

	async removeFile(filePath: string): Promise<void> {
		if (!this._db) return;
		await this._run("DELETE FROM chunks WHERE file_path = ?", [filePath]);
		this._dirty = true;
	}

	async searchSemantic(embedding: Float32Array, topK: number): Promise<Array<{ chunk: CodeSnippet; score: number }>> {
		if (!this._hnsw || !this._db) return [];
		if (this._dirty && this._hnswLib) {
			this._hnsw = new this._hnswLib.HierarchicalNSW('cosine', this._dim);
			this._hnsw.initIndex(this._maxElements);
			await this._restoreFromDb();
			this._dirty = false;
		}
		const result = this._hnsw.searchKnn(embedding, topK * 2);
		const items: Array<{ chunk: CodeSnippet; score: number }> = [];
		for (let i = 0; i < result.neighbors.length; i++) {
			const idx = result.neighbors[i];
			if (idx < 0) continue;
			const rows = await this._all('SELECT file_path, start_line, end_line, content FROM chunks ORDER BY rowid LIMIT 1 OFFSET ?', [idx]);
			if (!rows.length) continue;
			const r = rows[0];
			items.push({
				chunk: { filePath: r.file_path, startLine: r.start_line, endLine: r.end_line, content: r.content, score: 1 / (1 + result.distances[i]) },
				score: 1 / (1 + result.distances[i])
			});
			if (items.length >= topK) break;
		}
		return items;
	}

	async getStats(): Promise<{ totalFiles: number; totalChunks: number }> {
		if (!this._db) return { totalFiles: 0, totalChunks: 0 };
		const rows = await this._all('SELECT COUNT(DISTINCT file_path) as totalFiles, COUNT(*) as totalChunks FROM chunks');
		return rows.length ? { totalFiles: rows[0].totalFiles, totalChunks: rows[0].totalChunks } : { totalFiles: 0, totalChunks: 0 };
	}

	close(): void { this._db?.close(); this._db = null; this._hnsw = null; }

	private _run(sql: string, params?: any[]): Promise<void> { return new Promise((r, x) => { this._db.run(sql, params || [], (e: any) => e ? x(e) : r()); }); }
	private _all(sql: string, params?: any[]): Promise<any[]> { return new Promise((r, x) => { this._db.all(sql, params || [], (e: any, rows: any[]) => e ? x(e) : r(rows)); }); }
}
