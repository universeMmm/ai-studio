/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sqlite3 from '@vscode/sqlite3';
import { recordFor, vectorFor, percentile } from './vectors.mjs';
import { environment, memory, collect } from './metrics.mjs';

const baseline = process.argv.includes('--baseline');
const { createNodeIndexStore } = await import(new URL(`../../../../.build/test-ai/src/vs/platform/ai/node/indexStore${baseline ? '.baseline' : ''}.js`, import.meta.url));
const dimensions = Number(process.env.INDEX_STRESS_DIMENSIONS ?? 3072), count = Number(process.env.INDEX_STRESS_FILES ?? 100000);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-native-stress-'));
await fs.mkdir(path.join(root, '.ai-studio'));
const db = await new Promise((resolve, reject) => { const db = new sqlite3.Database(path.join(root, '.ai-studio/index.db'), error => error ? reject(error) : resolve(db)); });
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
const report = { kind: 'native-reload', count, dimensions, baseline, vectorBytes: count * dimensions * 4, environment: environment(), phases: {}, checks: {} };
let store, dbClosed = false, peakRss = 0;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); };
const sampler = setInterval(sample, 10);
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
	await run('COMMIT'); await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); dbClosed = true; await collect();
	report.phases.before = memory();
	// Abort after loading has made progress, then reopen the same database in full.
	store = await createNodeIndexStore(root);
	const reloadController = new AbortController(); let abortAt, cancelTimer, rejected = false;
	let start = performance.now();
	try {
		await store.initialize(reloadController.signal, () => {
			cancelTimer ??= setTimeout(() => { abortAt = performance.now(); reloadController.abort(); }, 10);
		});
	} catch (error) { rejected = error.name === 'AbortError'; } finally { clearTimeout(cancelTimer); }
	report.phases.reloadCancel = { rejected, loaded: store.stats.totalFiles, totalMs: performance.now() - start, afterAbortMs: performance.now() - abortAt };
	report.checks.reloadCancellation = rejected && store.stats.totalFiles >= 128 && store.stats.totalFiles < count && report.phases.reloadCancel.afterAbortMs < 200;
	await store.close(); await collect();
	start = performance.now();
	store = await createNodeIndexStore(root); await store.initialize(); await collect();
	report.phases.reload = { durationMs: performance.now() - start, memory: memory() };
	report.checks.fileCount = store.stats.totalFiles === count;
	const samples = [], query = vectorFor(count - 7, dimensions);
	report.checks.exactSelfMatch = true;
	for (let i = 0; i < 9; i++) {
		start = performance.now(); const hits = await store.searchSemantic(query, 10); samples.push(performance.now() - start);
		report.checks.exactSelfMatch &&= hits[0]?.chunk.filePath === recordFor(count - 7, dimensions).file;
	}
	report.phases.query = { samplesMs: samples, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95) };
	report.checks.queryLatency = report.phases.query.p95Ms < 2000;
	const queryController = new AbortController(); rejected = false; abortAt = undefined; start = performance.now();
	cancelTimer = setTimeout(() => { abortAt = performance.now(); queryController.abort(); }, 10);
	try { await store.searchSemantic(query, 10, queryController.signal); } catch (error) { rejected = error.name === 'AbortError'; } finally { clearTimeout(cancelTimer); }
	report.phases.cancel = { rejected, totalMs: performance.now() - start, afterAbortMs: performance.now() - abortAt };
	report.checks.cancelsSearch = rejected && report.phases.cancel.totalMs < 150;
	await store.close(); await collect();
	report.phases.close = memory();
	report.checks.releasesBuffers = report.phases.close.external < report.phases.before.external + 32 * 1024 * 1024;
	report.memory = { peakRss: Math.max(peakRss, report.phases.close.maxRSS) };
	report.checks.reloadPeak = report.memory.peakRss < report.phases.before.rss + report.vectorBytes * 1.6 + 256 * 1024 * 1024;
	report.pass = Object.values(report.checks).every(Boolean);
} catch (error) { report.failure = error.stack; report.pass = false; }
finally {
	clearInterval(sampler); await store?.close();
	if (!dbClosed) { await new Promise(resolve => db.close(resolve)); }
	await fs.mkdir('.build/ai-index-stress', { recursive: true });
	await fs.writeFile(`.build/ai-index-stress/native-${dimensions}${baseline ? '-baseline' : ''}.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	if (!report.pass && !baseline) { process.exitCode = 1; }
}
