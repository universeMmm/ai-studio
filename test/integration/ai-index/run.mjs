/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { launchDesktop } from './desktop.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-index-'));
const profile = path.join(tmp, 'profile'), workspace = path.join(tmp, 'workspace 中文 space');
const report = { generatedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version, commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null }, checks: {}, requests: [], measurements: {}, errors: [] };
let app, page, stage = 'setup', block = false, blocked = false, aborted = false;
const sockets = new Set();
const server = http.createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, http-referer, x-title');
	if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
	if (req.url !== '/v1/embeddings') { res.writeHead(404).end(); return; }
	let data = ''; for await (const chunk of req) { data += chunk; }
	const { input } = JSON.parse(data);
	report.requests.push({ size: input.length, at: Date.now() });
	if (block) { blocked = true; res.on('close', () => { aborted = true; }); return; }
	res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text.includes('updated') ? [0, 1] : [1, 0] })) }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.mkdir(path.join(profile, 'User'), { recursive: true });
await fs.mkdir(workspace);
await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(workspace, `file-${String(i).padStart(4, '0')}.ts`), `export const value${i} = ${i};\n`)));
await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
	'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
	'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'window.dialogStyle': 'custom',
	'ai.apiType': 'openai', 'ai.apiBase': `http://127.0.0.1:${server.address().port}/v1`, 'ai.modelId': 'fixture',
	'ai.index.enabled': false, 'ai.index.requestInterval': 0, 'ai.index.batchSize': 16,
}));
async function launch() {
	app = await launchDesktop(workspace, profile, path.join(tmp, 'extensions'));
	page = await app.firstWindow(); page.setDefaultTimeout(60000);
	page.on('pageerror', error => report.errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error' || message.text().includes('[AIIndexService]') || message.text().includes('[AIModelService]')) { report.errors.push(message.text()); } });
	await page.locator('.monaco-workbench').waitFor();
	await page.evaluate(async () => {
		const base = location.href.split('/out/')[0] + '/out/';
		const load = name => import(base + name);
		const [contrib, index, config, credentials, commands] = await Promise.all([
			load('vs/workbench/common/contributions.js'), load('vs/platform/ai/browser/aiIndexService.js'),
			load('vs/platform/configuration/common/configuration.js'), load('vs/platform/ai/browser/credentialService.js'), load('vs/platform/commands/common/commands.js'),
		]);
		contrib.WorkbenchContributionsRegistry.INSTANCE.instantiationService.invokeFunction(accessor => {
			window.indexFixture = { index: accessor.get(index.IAIIndexService), config: accessor.get(config.IConfigurationService), credentials: accessor.get(credentials.IAIKeychainService), commands: accessor.get(commands.ICommandService), target: config.ConfigurationTarget.USER_LOCAL };
		});
		await window.indexFixture.credentials.setApiKey('local-fixture-key');
	});
}
async function setting(key, value) { await page.evaluate(async ({ key, value }) => { const f = window.indexFixture; await f.config.updateValue(key, value, f.target); }, { key, value }); }
async function idle(files) {
	await page.waitForFunction(expected => { const s = window.indexFixture.index.stats; return s.state === 'error' || s.state === 'idle' && s.totalFiles === expected; }, files, { timeout: 60000 });
	assert.equal(await page.evaluate(() => window.indexFixture.index.stats.state), 'idle', report.errors.join('\n'));
}
async function until(condition) {
	const deadline = Date.now() + 20000;
	while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out: ' + stage); await new Promise(resolve => setTimeout(resolve, 20)); }
}
try {
	stage = 'initial disabled state'; await launch();
	stage = 'Electron native modules and process cancellation';
	report.native = await app.evaluate(async (_electron, { moduleUrl, root, nodeBinary }) => {
		const require = process.getBuiltinModule('module').createRequire(moduleUrl);
		return require(process.getBuiltinModule('url').fileURLToPath(moduleUrl)).runNativeChecks(root, nodeBinary);
	}, { moduleUrl: new URL('./native-checks.mjs', import.meta.url).href, root: path.join(tmp, 'native checks'), nodeBinary: process.execPath });
	Object.assign(report.checks, report.native.checks);
	assert.equal(report.requests.length, 0); report.checks.disabledNoRequests = true;
	stage = '1000 file batched build';
	const start = Date.now(); await setting('ai.index.enabled', true); await idle(1000);
	report.measurements.initialBuildMs = Date.now() - start;
	report.measurements.initialRequests = report.requests.length;
	assert.equal(report.requests.length, 63); assert.ok(report.requests.every(call => call.size <= 16));
	report.checks.batchedBuild = true;
	stage = 'unchanged incremental scan';
	let requests = report.requests.length;
	const scanStart = Date.now(); await page.evaluate(() => window.indexFixture.index.reindex()); await idle(1000);
	report.measurements.unchangedScanMs = Date.now() - scanStart;
	assert.equal(report.requests.length, requests); report.checks.unchangedNoRequests = true;
	stage = 'native watcher update';
	await fs.writeFile(path.join(workspace, 'file-0000.ts'), 'export const updated = true;\n');
	await until(() => report.requests.length === requests + 1); await idle(1000);
	report.checks.nativeWatcherUpdate = true;
	stage = 'native watcher add and rename';
	await fs.mkdir(path.join(workspace, 'nested'));
	await fs.writeFile(path.join(workspace, 'nested', 'new.ts'), 'const added = true;\n'); await idle(1001);
	requests = report.requests.length;
	await fs.rename(path.join(workspace, 'nested', 'new.ts'), path.join(workspace, 'nested', 'renamed.ts'));
	await until(() => report.requests.length > requests); await idle(1001);
	await fs.rm(path.join(workspace, 'nested'), { recursive: true }); await idle(1000);
	report.checks.nativeWatcherAddRenameDelete = true;
	stage = 'restart uses IndexedDB fingerprints';
	requests = report.requests.length;
	await app.close(); app = undefined; await launch(); await idle(1000);
	assert.equal(report.requests.length, requests); report.checks.restartNoRequests = true;
	stage = 'Unicode paths, exact includes and keyword fallback';
	const unicodeDir = path.join(workspace, '目录 空格'); await fs.mkdir(unicodeDir);
	await fs.writeFile(path.join(unicodeDir, '搜索.ts'), 'const KEYWORD_FIXTURE = true;\n'); await idle(1001);
	await setting('ai.index.enabled', false); await setting('ai.index.include', ['目录 空格/*.ts']);
	const hits = await page.evaluate(() => window.indexFixture.index.search('KEYWORD_FIXTURE', 5));
	assert.equal(hits.length, 1); assert.equal(hits[0].filePath.replace(/\\/g, '/'), '目录 空格/搜索.ts');
	await setting('ai.index.include', ['**/*']); await setting('ai.index.enabled', true); await idle(1001);
	await fs.rm(unicodeDir, { recursive: true }); await idle(1000);
	report.checks.unicodePathsAndIncludes = true;
	stage = 'case-only file rename';
	await fs.rename(path.join(workspace, 'file-0003.ts'), path.join(workspace, 'FILE-0003.ts'));
	await page.waitForFunction(() => [...window.indexFixture.index.indexes.values()].some(({ builder }) => [...builder.getStore().filePaths].some(file => /[\\/]FILE-0003.ts$/.test(file))));
	await idle(1000); report.checks.caseOnlyRename = true;
	stage = 'cancel active provider fetch'; block = true;
	await fs.writeFile(path.join(workspace, 'file-0001.ts'), 'const BLOCK_INDEX = true;\n');
	await until(() => blocked);
	const cancelStart = performance.now();
	await page.evaluate(() => window.indexFixture.commands.executeCommand('ai.index.cancel'));
	await until(() => aborted);
	report.measurements.fetchCancelMs = performance.now() - cancelStart;
	assert.ok(report.measurements.fetchCancelMs < 1500);
	assert.equal(await page.evaluate(() => window.indexFixture.index.stats.state), 'cancelled');
	report.checks.fetchCancellation = true;
	stage = 'resume cancelled update'; block = false;
	await page.evaluate(() => window.indexFixture.commands.executeCommand('ai.reindex')); await idle(1000);
	report.checks.resume = true;
	stage = 'caller cancellation of hybrid search'; block = true; blocked = false; aborted = false;
	await page.evaluate(() => {
		const f = window.indexFixture; f.queryController = new AbortController();
		f.query = f.index.search('QUERY_CANCEL_FIXTURE', 5, f.queryController.signal).then(() => 'resolved', error => error.name);
	});
	await until(() => blocked);
	report.measurements.queryCancelMs = await page.evaluate(async () => {
		const f = window.indexFixture; const start = performance.now(); f.queryController.abort();
		if (await f.query !== 'AbortError') { throw new Error('Search did not reject cancellation'); }
		return performance.now() - start;
	});
	await until(() => aborted); block = false;
	assert.ok(report.measurements.queryCancelMs < 1000); report.checks.searchCancellation = true;
	stage = 'live disable and catch up';
	await page.evaluate(() => window.indexFixture.commands.executeCommand('ai.index.toggle')); requests = report.requests.length;
	await fs.writeFile(path.join(workspace, 'file-0002.ts'), 'const updatedWhileDisabled = true;\n');
	await new Promise(resolve => setTimeout(resolve, 700));
	assert.equal(report.requests.length, requests);
	await page.evaluate(() => window.indexFixture.commands.executeCommand('ai.index.toggle')); await idle(1000);
	assert.equal(report.requests.length, requests + 1); report.checks.disableAndCatchUp = true;
	stage = 'configured limit'; await setting('ai.index.maxFiles', 100); await idle(100);
	assert.equal(await page.evaluate(() => window.indexFixture.index.stats.limited), true);
	report.checks.fileLimit = true;

	report.pass = true;
} catch (error) {
	report.pass = false; report.failure = { stage, error: error.stack ?? String(error) };
	if (page) { report.stats = await page.evaluate(() => window.indexFixture?.index.stats).catch(() => undefined); }
	report.logs = {};
	for (const name of await fs.readdir(path.join(profile, 'logs'), { recursive: true }).catch(() => [])) {
		if (String(name).endsWith('renderer.log') || String(name).endsWith('main.log')) { report.logs[name] = (await fs.readFile(path.join(profile, 'logs', name), 'utf8')).slice(-10000); }
	}
	process.exitCode = 1;
} finally {
	if (app) { await app.close().catch(() => {}); }
	for (const socket of sockets) { socket.destroy(); }
	await new Promise(resolve => server.close(resolve));
	await fs.mkdir('.build/ui-redesign', { recursive: true });
	await fs.writeFile('.build/ui-redesign/studio-index-runtime-report.json', JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
