/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const electron = createRequire(import.meta.url)('electron');
const directory = '.build/ai-index-stress';
await fs.mkdir(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), cases: [], implementation: {} };
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
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(test.binary, [...test.args, path.join('test/integration/ai-index/stress', test.entry)], {
			stdio: 'inherit', env: { ...process.env, INDEX_STRESS_FILES: '100000', INDEX_STRESS_DIMENSIONS: String(test.dimensions), ...test.env },
		});
		child.once('error', reject); child.once('close', resolve);
	});
	const result = await fs.readFile(output, 'utf8').then(JSON.parse).catch(() => null);
	report.cases.push({ name: test.name, exitCode, durationMs: Date.now() - started, result, pass: exitCode === 0 && result?.pass === true });
}
report.pass = report.cases.every(test => test.pass);
await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log('Index stress:', report.cases.map(test => `${test.name}=${test.pass ? 'PASS' : 'FAIL'}`).join(', '));
if (!report.pass) { process.exitCode = 1; }
