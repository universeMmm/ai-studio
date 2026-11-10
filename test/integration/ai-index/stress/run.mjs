/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { developmentElectronPath } from '../desktop.mjs';
import { environment } from './metrics.mjs';

const electron = await developmentElectronPath();
const directory = '.build/ai-index-stress';
await fs.mkdir(directory, { recursive: true });
process.env.INDEX_STRESS_RUN_ID = randomUUID();
const report = { schema: 2, generatedAt: new Date().toISOString(), environment: environment(), cases: [], implementation: {}, pass: false };
const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
await save();
for (const file of ['common/indexStore.ts', 'common/indexCancellation.ts', 'common/indexLimits.ts', 'browser/indexBuilder.ts', 'browser/indexStorage.ts', 'browser/aiIndexService.ts', 'browser/indexOptions.ts', 'browser/indexRipgrep.ts', 'node/indexStore.ts', 'node/commandRunner.ts']) {
	report.implementation[file] = createHash('sha256').update(await fs.readFile(path.join('src/vs/platform/ai', file))).digest('hex');
}
const cases = [
	{ name: 'store-1536', entry: 'store.mjs', binary: process.execPath, dimensions: 1536, args: ['--expose-gc', '--max-old-space-size=2048'] },
	{ name: 'store-3072', entry: 'store.mjs', binary: process.execPath, dimensions: 3072, args: ['--expose-gc', '--max-old-space-size=2048'] },
	{ name: 'native-3072', entry: 'native.mjs', binary: electron, dimensions: 3072, args: ['--expose-gc', '--max-old-space-size=2048'], env: { ELECTRON_RUN_AS_NODE: '1' } },
	{ name: 'workspace-3072', entry: 'workspace.mjs', binary: process.execPath, dimensions: 3072, args: [] },
];
// Separate, sequential processes make RSS and latency measurements independent of other cases.
for (const test of cases) {
	const output = path.join(directory, test.name + '.json');
	await fs.rm(output, { force: true });
	const started = Date.now();
	const completion = await new Promise(resolve => {
		const child = spawn(test.binary, [...test.args, path.join('test/integration/ai-index/stress', test.entry)], {
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: process.platform !== 'win32', env: { ...process.env, INDEX_STRESS_FILES: '100000', INDEX_STRESS_DIMENSIONS: String(test.dimensions), ...test.env },
		});
		let timedOut = false, desktopPid;
		child.on('message', message => { if (message?.type === 'desktop-process' && Number.isInteger(message.pid) && message.pid > 0) { desktopPid = message.pid; } });
		const timeout = setTimeout(() => {
			timedOut = true;
			// Terminate Electron and file-watcher descendants as well as the harness.
			if (process.platform === 'win32') {
				const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'inherit' });
				killer.once('error', () => child.kill());
			} else {
				// Playwright starts Electron in its own process group on POSIX.
				if (desktopPid) { try { process.kill(-desktopPid, 'SIGKILL'); } catch { /* Already exited. */ } }
				try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
			}
		}, (test.entry === 'workspace.mjs' ? 25 : 10) * 60000);
		child.once('error', error => { clearTimeout(timeout); resolve({ exitCode: null, error: error.message, timedOut }); });
		child.once('close', (exitCode, signal) => { clearTimeout(timeout); resolve({ exitCode, signal, timedOut }); });
	});
	const result = await fs.readFile(output, 'utf8').then(JSON.parse).catch(() => null);
	report.cases.push({ name: test.name, ...completion, durationMs: Date.now() - started, result,
		pass: completion.exitCode === 0 && !completion.timedOut && result?.pass === true && result.count === 100000 && result.dimensions === test.dimensions && result.environment.stressRunId === report.environment.stressRunId });
	await save();
}
report.pass = report.cases.every(test => test.pass);
await save();
console.log('Index stress:', report.cases.map(test => `${test.name}=${test.pass ? 'PASS' : 'FAIL'}`).join(', '));
if (!report.pass) { process.exitCode = 1; }
