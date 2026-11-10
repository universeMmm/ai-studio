/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Loaded in Electron's main process, so all native modules use the shipped ABI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createNodeIndexStore } from '../../../out/vs/platform/ai/node/indexStore.js';
import { runAICommand } from '../../../out/vs/platform/ai/node/commandRunner.js';

const require = createRequire(import.meta.url);
async function until(condition) {
	const deadline = performance.now() + 15000;
	while (!await condition()) {
		assert.ok(performance.now() < deadline, 'native fixture timed out');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

export async function runNativeChecks(root, nodeBinary) {
	await fs.mkdir(root, { recursive: true });
	const checks = {}, measurements = {};
	const environment = { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules };
	// A memory fallback must never turn an ABI failure into a passing test.
	const sqlite = require('@vscode/sqlite3');
	const db = await new Promise((resolve, reject) => { const db = new sqlite.Database(':memory:', error => error ? reject(error) : resolve(db)); });
	try { await new Promise((resolve, reject) => db.get('SELECT sqlite_version() AS version', (error, row) => error ? reject(error) : resolve(environment.sqlite = row.version))); }
	finally { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
	checks.sqliteABI = true;
	const watchRoot = path.join(root, 'watch 中文'); await fs.mkdir(watchRoot);
	const events = [];
	const watcher = require('@parcel/watcher');
	const subscription = await watcher.subscribe(watchRoot, (error, changes) => { if (error) { events.push({ error: error.message }); } else { events.push(...changes); } });
	try {
		const file = path.join(watchRoot, 'native file.ts'); await fs.writeFile(file, 'native');
		await until(() => events.some(event => event.type === 'create' && path.basename(event.path) === 'native file.ts'));
		assert.ok(!events.some(event => event.error), JSON.stringify(events));
	} finally { await subscription.unsubscribe(); }
	checks.parcelWatcherABI = true;
	const listing = await runAICommand({ command: 'rg', args: ['--files', '--null', '--', '.'], cwd: watchRoot }, new AbortController().signal);
	assert.equal(listing.exitCode, 0); assert.ok(listing.stdout.includes('native file.ts\0'));
	checks.ripgrepBinary = true;

	const storeRoot = path.join(root, 'sqlite 中文');
	const file = path.join(storeRoot, 'source.ts');
	const stamp = { mtime: 1, size: 8, hash: 'fixture', embeddingKey: 'fixture-3072' };
	const entry = { chunk: { id: 'fixture', filePath: file, startLine: 1, endLine: 1, content: 'const a=1', kind: 'module', name: 'a' }, embedding: new Float32Array(3072).fill(0.5) };
	let store = await createNodeIndexStore(storeRoot); await store.initialize();
	try { for (let i = 0; i < 512; i++) { await store.replaceFile(file + i, [{ ...entry, chunk: { ...entry.chunk, id: String(i), filePath: file + i } }], stamp); } }
	finally { await store.close(); }
	store = await createNodeIndexStore(storeRoot);
	const controller = new AbortController();
	let cancelledAt;
	try {
		await assert.rejects(store.initialize(controller.signal, () => {
			if (cancelledAt === undefined) { cancelledAt = performance.now(); controller.abort(); }
		}), { name: 'AbortError' });
		measurements.nativeReloadCancelMs = performance.now() - cancelledAt;
		assert.ok(measurements.nativeReloadCancelMs < 1000);
		assert.ok(store.stats.totalFiles > 0 && store.stats.totalFiles < 512);
	} finally { await store.close(); }
	checks.nativeReloadCancellation = true;
	store = await createNodeIndexStore(storeRoot); await store.initialize();
	try {
		assert.equal(store.stats.totalChunks, 512); assert.equal(store.getMetadata(file + '0')?.hash, stamp.hash);
		const start = performance.now();
		assert.equal((await store.searchSemantic(entry.embedding, 3)).length, 3);
		measurements.native3072SearchMs = performance.now() - start;
	} finally { await store.close(); }
	// On Windows an open SQLite handle prevents this directory from being removed.
	await fs.rm(storeRoot, { recursive: true });
	checks.nativePersistenceAndClose = true;

	// A child keeps the command's pipes open. Cancellation must kill the entire
	// process tree, not merely return an AbortError while work keeps running.
	const ready = path.join(root, 'child-ready');
	const pulse = path.join(root, 'child-pulse');
	const childScript = `const fs = require('fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => fs.writeFileSync(process.argv[2], String(Date.now())), 10);`;
	const parentScript = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, ...process.argv.slice(1)], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
	const abort = new AbortController();
	const pending = runAICommand({ command: nodeBinary, args: ['-e', parentScript, ready, pulse], timeout: 15000 }, abort.signal);
	try {
		await until(async () => await fs.readFile(pulse).then(() => true, () => false));
		const start = performance.now(); abort.abort();
		const result = await pending;
		measurements.processTreeCancelMs = performance.now() - start;
		assert.equal(result.exitCode, -1); assert.equal(result.stderr, 'Command cancelled');
		assert.ok(measurements.processTreeCancelMs < 2000, JSON.stringify(measurements));
		const stopped = await fs.readFile(pulse, 'utf8');
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(await fs.readFile(pulse, 'utf8'), stopped, 'descendant still running after cancellation');
	} finally { abort.abort(); await pending; }
	checks.processTreeCancellation = true;
	const start = performance.now();
	const timeout = await runAICommand({ command: nodeBinary, args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 100 }, new AbortController().signal);
	measurements.processTimeoutMs = performance.now() - start;
	assert.equal(timeout.exitCode, -1); assert.equal(timeout.stderr, 'Command timed out'); assert.ok(measurements.processTimeoutMs < 2000);
	checks.processTimeout = true;
	return { checks, measurements, environment };
}
