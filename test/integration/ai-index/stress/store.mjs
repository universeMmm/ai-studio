/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { recordFor, vectorFor, percentile } from './vectors.mjs';
import { environment, memory, collect } from './metrics.mjs';

const baseline = process.argv.includes('--baseline');
const dimensions = Number(process.env.INDEX_STRESS_DIMENSIONS ?? 3072);
const count = Number(process.env.INDEX_STRESS_FILES ?? 100000);
const { IndexStore } = await import(new URL(`../../../../.build/test-ai/src/vs/platform/ai/common/indexStore${baseline ? '.baseline' : ''}.js`, import.meta.url));
const report = { kind: 'exact-store', baseline, count, dimensions, vectorBytes: count * dimensions * 4, environment: environment(), phases: {}, queries: [], checks: {} };
const store = new IndexStore();
let peakRss = 0, maxTickDelay = 0, lastTick = performance.now();
const sample = () => { const now = performance.now(); maxTickDelay = Math.max(maxTickDelay, now - lastTick - 10); lastTick = now; peakRss = Math.max(peakRss, process.memoryUsage.rss()); };
const timer = setInterval(sample, 10);
const before = memory();
try {
	let start = performance.now();
	for (let i = 0; i < count; i++) {
		const record = recordFor(i, dimensions);
		await store.replaceFile(record.file, record.entries, record.metadata);
		if (i % 512 === 0) { sample(); await new Promise(resolve => setImmediate(resolve)); }
	}
	globalThis.gc?.();
	report.phases.build = { durationMs: performance.now() - start, memory: memory() };
	report.checks.fileCount = store.stats.totalFiles === count;
	const query = vectorFor(count - 7, dimensions);
	report.checks.exactSelfMatch = true;
	for (let i = 0; i < 9; i++) {
		start = performance.now();
		const results = await store.searchSemantic(query, 10);
		report.queries.push(performance.now() - start);
		report.checks.exactSelfMatch &&= results[0]?.chunk.filePath.endsWith(`/file-${String(count - 7).padStart(6, '0')}.ts`) === true;
	}
	report.phases.query = { p50Ms: percentile(report.queries, 0.5), p95Ms: percentile(report.queries, 0.95), memory: memory() };
	const controller = new AbortController();
	let cancelledAt;
	start = performance.now();
	const cancelTimer = setTimeout(() => { cancelledAt = performance.now(); controller.abort(); }, 10);
	let rejected = false;
	try { await store.searchSemantic(query, 10, controller.signal); } catch (error) { rejected = error.name === 'AbortError'; } finally { clearTimeout(cancelTimer); }
	report.phases.cancel = { rejected, totalMs: performance.now() - start, afterAbortMs: performance.now() - cancelledAt };
	report.checks.cancelsSearch = rejected && report.phases.cancel.totalMs < 150;
	await store.close(); await collect();
	report.phases.close = { memory: memory() };
	report.checks.releasesBuffers = report.phases.close.memory.external < before.external + 32 * 1024 * 1024;
	report.memory = { before, peakRss: Math.max(peakRss, process.resourceUsage().maxRSS * 1024), maxTickDelayMs: maxTickDelay };
	report.checks.memoryBound = report.memory.peakRss < before.rss + report.vectorBytes * 1.6 + 256 * 1024 * 1024;
	report.checks.queryLatency = report.phases.query.p95Ms < 2000;
	report.pass = Object.values(report.checks).every(Boolean);
} catch (error) { report.failure = error.stack; report.pass = false; }
finally {
	clearInterval(timer); await store.close();
	await fs.mkdir('.build/ai-index-stress', { recursive: true });
	await fs.writeFile(`.build/ai-index-stress/store-${dimensions}${baseline ? '-baseline' : ''}.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	if (!report.pass && !baseline) { process.exitCode = 1; }
}
