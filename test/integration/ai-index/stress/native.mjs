/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sqlite3 from '@vscode/sqlite3';
import { recordFor } from './vectors.mjs';

const baseline = process.argv.includes('--baseline');
const { createNodeIndexStore } = await import(new URL(`../../../../.build/test-ai/src/vs/platform/ai/node/indexStore${baseline ? '.baseline' : ''}.js`, import.meta.url));
const dimensions = Number(process.env.INDEX_STRESS_DIMENSIONS ?? 3072), count = Number(process.env.INDEX_STRESS_FILES ?? 100000);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-native-stress-'));
await fs.mkdir(path.join(root, '.ai-studio'));
const db = await new Promise((resolve, reject) => { const db = new sqlite3.Database(path.join(root, '.ai-studio/index.db'), error => error ? reject(error) : resolve(db)); });
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
const memory = () => ({ ...process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS * 1024 });
const collect = async () => { for (let i = 0; i < 4; i++) { globalThis.gc?.(); await new Promise(resolve => setTimeout(resolve, 25)); } };
const report = { kind: 'native-reload', count, dimensions, baseline, vectorBytes: count * dimensions * 4, phases: {}, checks: {} };
let store;
try {
	// Fixture setup is one transaction; measured reload uses the production storage implementation.
	await run('PRAGMA journal_mode=OFF'); await run('PRAGMA synchronous=OFF');
	await run('CREATE TABLE chunks (id TEXT PRIMARY KEY, file_path TEXT, start_line INTEGER, end_line INTEGER, content TEXT, kind TEXT, name TEXT, embedding BLOB)');
	await run('CREATE INDEX idx_chunks_file ON chunks(file_path)');
	await run('CREATE TABLE index_files (file_path TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
	await run('BEGIN');
	for (let i = 0; i < count; i++) {
		const record = recordFor(i, dimensions); const { chunk, embedding } = record.entries[0];
		await run('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?)', [chunk.id, record.file, chunk.startLine, chunk.endLine, chunk.content, chunk.kind, chunk.name, Buffer.from(embedding.buffer)]);
		await run('INSERT INTO index_files VALUES (?,?)', [record.file, JSON.stringify(record.metadata)]);
	}
	await run('COMMIT'); await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); await collect();
	report.phases.before = memory();
	let start = performance.now();
	store = await createNodeIndexStore(root); await store.initialize(); await collect();
	report.phases.reload = { durationMs: performance.now() - start, memory: memory() };
	report.checks.fileCount = store.stats.totalFiles === count;
	store.close(); await store.replaceFile('/closed', []); await collect();
	report.phases.close = memory();
	report.checks.releasesBuffers = report.phases.close.external < report.phases.before.external + 32 * 1024 * 1024;
	report.checks.reloadPeak = Math.max(report.phases.reload.memory.maxRSS, report.phases.close.maxRSS) < report.phases.before.rss + report.vectorBytes * 1.6 + 256 * 1024 * 1024;
	report.pass = Object.values(report.checks).every(Boolean);
} catch (error) { report.failure = error.stack; report.pass = false; }
finally {
	store?.close();
	await fs.mkdir('.build/ai-index-stress', { recursive: true });
	await fs.writeFile(`.build/ai-index-stress/native-${dimensions}${baseline ? '-baseline' : ''}.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	await fs.rm(root, { recursive: true, force: true });
	if (!report.pass && !baseline) { process.exitCode = 1; }
}
