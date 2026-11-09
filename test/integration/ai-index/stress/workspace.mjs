/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { launchDesktop } from '../desktop.mjs';
import { percentile } from './vectors.mjs';
import { environment } from './metrics.mjs';

const count = Number(process.env.INDEX_STRESS_FILES ?? 100000);
const dimensions = Number(process.env.INDEX_STRESS_DIMENSIONS ?? 3072);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'index-workspace-stress-'));
const workspace = path.join(tmp, 'workspace'), profile = path.join(tmp, 'profile');
const report = { kind: 'desktop-workspace', count, dimensions, vectorBytes: count * dimensions * 4, listingBytes: 0, phases: {}, checks: {}, errors: [], environment: environment() };
let app, page, cdp, sampler, sampling = false, peakRendererBytes = 0, peakAppBytes = 0, stage = 'fixture', stderrTail = '', processExit;
const phase = value => { stage = value; console.log('Index stress: ' + stage); };
async function sample() {
	if (sampling || !app) { return; }
	sampling = true;
	try {
		const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
		peakAppBytes = Math.max(peakAppBytes, metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0));
		peakRendererBytes = Math.max(peakRendererBytes, ...metrics.filter(metric => metric.type === 'Tab').map(metric => Math.max(metric.memory.workingSetSize, metric.memory.peakWorkingSetSize ?? 0) * 1024));
	} catch { /* Renderer may be restarting. */ } finally { sampling = false; }
}
async function snapshot() {
	await sample();
	return { heap: await cdp.send('Runtime.getHeapUsage'), peakRendererBytes, peakAppBytes, stats: await page.evaluate(() => window.stress.index.stats) };
}
async function setting(key, value) { await page.evaluate(async ({ key, value }) => { const f = window.stress; await f.config.updateValue(key, value, f.target); }, { key, value }); }
async function idle(expected) {
	await page.waitForFunction(expected => {
		const s = window.stress.index.stats;
		return s.state === 'error' || s.state === 'idle' && (expected === null || s.totalFiles === expected);
	}, expected ?? null, { timeout: 600000 });
	assert.equal(await page.evaluate(() => window.stress.index.stats.state), 'idle', report.errors.join('\n'));
}
async function launch() {
	app = await launchDesktop(workspace, profile, path.join(tmp, 'extensions'));
	process.send?.({ type: 'desktop-process', pid: app.process().pid });
	app.process().stderr?.on('data', data => { stderrTail = (stderrTail + data.toString()).slice(-65536); });
	app.process().once('exit', (code, signal) => { processExit = { code, signal }; });
	report.environment.desktop = await app.evaluate(() => ({ platform: process.platform, arch: process.arch, electron: process.versions.electron, modules: process.versions.modules }));
	page = await app.firstWindow(); page.setDefaultTimeout(600000); await page.locator('.monaco-workbench').waitFor();
	page.on('console', message => { if (message.type() === 'error' || message.text().includes('[AIIndexService]')) { report.errors.push(message.text()); } });
	page.on('pageerror', error => report.errors.push(error.message));
	cdp = await page.context().newCDPSession(page);
	await page.evaluate(async dimensions => {
		const base = location.href.split('/out/')[0] + '/out/';
		const load = name => import(base + name);
		const [contrib, index, config, model] = await Promise.all([
			load('vs/workbench/common/contributions.js'), load('vs/platform/ai/browser/aiIndexService.js'),
			load('vs/platform/configuration/common/configuration.js'), load('vs/platform/ai/browser/aiModelService.js'),
		]);
		contrib.WorkbenchContributionsRegistry.INSTANCE.instantiationService.invokeFunction(a => {
			window.stress = { index: a.get(index.IAIIndexService), config: a.get(config.IConfigurationService), model: a.get(model.IAIModelService), target: config.ConfigurationTarget.USER_LOCAL, requests: 0, texts: 0, heartbeats: [], lastTick: performance.now() };
		});
		const f = window.stress;
		// Dense, distinct 32-bit vectors. Only the provider is a fixture; file I/O,
		// enumeration, persistence, scheduler and hybrid search are production services.
		f.model.embed = async (texts, signal) => {
			signal?.throwIfAborted(); f.requests++; f.texts += texts.length;
			return texts.map(text => {
				let state = (Number(/value(\d+)/.exec(text)?.[1] ?? 0) + 1) >>> 0;
				const vector = new Float32Array(dimensions);
				for (let i = 0; i < dimensions; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; vector[i] = (state >>> 0) / 0xffffffff - 0.5; }
				return Array.from(vector);
			});
		};
		f.heartbeat = setInterval(() => { const now = performance.now(); f.heartbeats.push(Math.max(0, now - f.lastTick - 10)); f.lastTick = now; }, 10);
	}, dimensions);
}
try {
	phase('creating 100k real files');
	await fs.mkdir(workspace); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
	const groups = Math.ceil(count / 1000);
	for (let group = 0; group < groups; group++) {
		const directory = path.join(workspace, `group-${String(group).padStart(3, '0')}-${'nested-source-tree-'.repeat(8)}`); await fs.mkdir(directory);
		for (let start = group * 1000; start < Math.min(count, (group + 1) * 1000); start += 64) {
			await Promise.all(Array.from({ length: Math.min(64, count - start, (group + 1) * 1000 - start) }, (_, offset) => {
				const id = start + offset;
				const file = path.join(directory, `file-${String(id).padStart(6, '0')}.ts`);
				report.listingBytes += Buffer.byteLength('./' + path.relative(workspace, file)) + 1;
				return fs.writeFile(file, `export function value${id}() {\n  return ${id};\n}`);
			}));
		}
	}
	assert.ok(report.listingBytes > 10 * 1024 * 1024); report.checks.longPathListing = true;
	await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
		'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
		'ai.index.enabled': false, 'ai.index.maxFiles': count, 'ai.index.maxMemoryMB': 16, 'ai.index.batchSize': 128, 'ai.index.requestInterval': 0, 'ai.index.include': ['**/*.ts'],
	}));
	phase('launch and memory budget'); await launch(); sampler = setInterval(sample, 250);
	report.phases.before = await snapshot();
	let start = performance.now(); await setting('ai.index.enabled', true); await idle();
	report.phases.budget = { durationMs: performance.now() - start, ...await snapshot() };
	assert.ok(report.phases.budget.stats.memoryLimited); assert.ok(report.phases.budget.stats.memoryBytes <= 16 * 1024 * 1024);
	assert.ok(report.phases.budget.stats.totalFiles > 0 && report.phases.budget.stats.totalFiles < count);
	report.checks.memoryBudget = true;
	phase('full high-dimensional index'); start = performance.now();
	await setting('ai.index.maxMemoryMB', 2048); await idle(count);
	report.phases.build = { durationMs: performance.now() - start, ...await snapshot(), calls: await page.evaluate(() => ({ requests: window.stress.requests, texts: window.stress.texts })) };
	assert.ok(!report.phases.build.stats.memoryLimited); assert.equal(report.phases.build.stats.totalChunks, count);
	report.checks.completeIndex = true;
	phase('hybrid search latency'); const latencies = [];
	for (let i = 0; i < 7; i++) {
		start = performance.now(); const hits = await page.evaluate(id => window.stress.index.search('value' + id, 10), count - 7 - i);
		latencies.push(performance.now() - start);
		assert.ok(hits[0]?.filePath.endsWith(`file-${String(count - 7 - i).padStart(6, '0')}.ts`));
	}
	report.phases.query = { samplesMs: latencies, p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), ...await snapshot() };
	assert.ok(report.phases.query.p95Ms < 5000); report.checks.hybridLatency = true;
	phase('query cancellation');
	report.phases.queryCancel = await page.evaluate(async () => {
		const controller = new AbortController(), start = performance.now(); let abortAt = 0;
		const timer = setTimeout(() => { abortAt = performance.now(); controller.abort(); }, 10);
		try { await window.stress.index.search('value99993', 10, controller.signal); return { rejected: false }; }
		catch (error) { return { rejected: error.name === 'AbortError', totalMs: performance.now() - start, afterAbortMs: performance.now() - abortAt }; }
		finally { clearTimeout(timer); }
	});
	assert.ok(report.phases.queryCancel.rejected && report.phases.queryCancel.totalMs < 200); report.checks.queryCancellation = true;
	phase('incremental scan and cancellation');
	start = performance.now(); const requests = await page.evaluate(() => window.stress.requests);
	await page.evaluate(() => window.stress.index.reindex()); await idle(count);
	report.phases.unchanged = { durationMs: performance.now() - start, requests: await page.evaluate(() => window.stress.requests) - requests };
	assert.equal(report.phases.unchanged.requests, 0); report.checks.incrementalReuse = true;
	report.phases.scanCancel = await page.evaluate(async () => {
		const f = window.stress, start = performance.now(); let abortAt = 0;
		const pending = f.index.reindex();
		const timer = setTimeout(() => { abortAt = performance.now(); f.index.cancel(); }, 100);
		try { await pending; return { state: f.index.stats.state, totalMs: performance.now() - start, afterAbortMs: performance.now() - abortAt }; }
		finally { clearTimeout(timer); }
	});
	assert.equal(report.phases.scanCancel.state, 'cancelled'); assert.ok(report.phases.scanCancel.totalMs < 300 && report.phases.scanCancel.afterAbortMs < 200); report.checks.scanCancellation = true;
	phase('release and reload cancellation'); await setting('ai.index.enabled', false);
	for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); }
	report.phases.closed = await snapshot();
	report.checks.releasesBackingStorage = report.phases.closed.heap.backingStorageSize < report.phases.before.heap.backingStorageSize + 32 * 1024 * 1024;
	assert.ok(report.checks.releasesBackingStorage);
	await setting('ai.index.enabled', true);
	await page.waitForFunction(() => window.stress.index.stats.totalFiles >= 128, undefined, { polling: 5 });
	report.phases.reloadCancel = await page.evaluate(async () => {
		const f = window.stress, loaded = f.index.stats.totalFiles;
		const drained = f.index.reindex(), start = performance.now(); f.index.cancel(); await drained;
		return { loaded, durationMs: performance.now() - start, state: f.index.stats.state };
	});
	assert.equal(report.phases.reloadCancel.state, 'cancelled');
	assert.ok(report.phases.reloadCancel.loaded < count && report.phases.reloadCancel.durationMs < 200); report.checks.reloadCancellation = true;
	phase('complete persisted reload'); start = performance.now(); await page.evaluate(() => window.stress.index.reindex()); await idle(count);
	report.phases.reload = { durationMs: performance.now() - start, ...await snapshot() };
	assert.equal(await page.evaluate(() => window.stress.requests), requests); report.checks.persistedReuse = true;
	report.heartbeat = await page.evaluate(() => { const f = window.stress; clearInterval(f.heartbeat); return { maxMs: f.heartbeats.reduce((max, delay) => Math.max(max, delay), 0), p95Ms: [...f.heartbeats].sort((a, b) => a - b)[Math.floor(f.heartbeats.length * .95)] }; });
	report.checks.peakMemory = peakRendererBytes > report.vectorBytes && peakRendererBytes < report.phases.before.peakRendererBytes + report.vectorBytes * 1.7 + 512 * 1024 * 1024;
	assert.ok(report.checks.peakMemory); report.pass = true;
} catch (error) {
	report.pass = false; report.failure = { stage, error: error.stack, peakRendererBytes, peakAppBytes };
	report.diagnostics = { processExit, stderrTail };
	if (page) { report.lastStats = await page.evaluate(() => window.stress?.index.stats).catch(() => null); }
	process.exitCode = 1;
} finally {
	clearInterval(sampler); if (app) { await app.close().catch(() => {}); }
	await fs.mkdir('.build/ai-index-stress', { recursive: true });
	await fs.writeFile(`.build/ai-index-stress/workspace-${dimensions}.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
