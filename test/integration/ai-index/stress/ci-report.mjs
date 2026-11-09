/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const report = JSON.parse(await fs.readFile('.build/ai-index-stress/report.json', 'utf8'));
assert.equal(report.schema, 2);
assert.equal(report.pass, true, JSON.stringify(report.cases.filter(test => !test.pass)));
assert.equal(report.environment.platform, process.platform);
assert.ok(report.environment.stressRunId);
if (process.env.GITHUB_SHA) { assert.equal(report.environment.commit, process.env.GITHUB_SHA); }
if (process.env.GITHUB_RUN_ID) { assert.equal(report.environment.runId, process.env.GITHUB_RUN_ID); }
if (process.env.GITHUB_RUN_ATTEMPT) { assert.equal(report.environment.runAttempt, process.env.GITHUB_RUN_ATTEMPT); }
assert.deepEqual(report.cases.map(test => test.name), ['store-1536', 'store-3072', 'native-3072', 'workspace-3072']);
for (const [file, hash] of Object.entries(report.implementation)) {
	assert.equal(createHash('sha256').update(await fs.readFile('src/vs/platform/ai/' + file)).digest('hex'), hash, file);
}
const positive = value => assert.ok(Number.isFinite(value) && value > 0, `Invalid measurement: ${value}`);
const rows = [];
for (const test of report.cases) {
	const r = test.result, workspace = test.name.startsWith('workspace');
	assert.equal(test.pass, true); assert.equal(test.exitCode, 0);
	assert.equal(r.pass, true); assert.equal(r.count, 100000);
	assert.equal(r.dimensions, test.name.endsWith('1536') ? 1536 : 3072);
	assert.equal(r.environment.platform, process.platform);
	assert.equal(r.environment.stressRunId, report.environment.stressRunId);
	assert.equal(r.environment.commit, report.environment.commit);
	assert.ok(Object.keys(r.checks).length >= 6 && Object.values(r.checks).every(value => value === true));
	const peak = workspace ? r.phases.reload.peakRendererBytes : r.memory.peakRss;
	const cancel = workspace ? r.phases.queryCancel : r.phases.cancel;
	const reload = r.phases.reloadCancel;
	positive(peak); positive(r.phases.query.p95Ms); positive(cancel.totalMs);
	assert.equal(cancel.rejected, true);
	assert.ok(r.phases.query.p95Ms < (workspace ? 5000 : 2000));
	assert.ok(cancel.totalMs < (workspace ? 200 : 150));
	if (test.name.startsWith('native')) {
		assert.ok(r.environment.electron && r.environment.modules);
		assert.equal(reload.rejected, true); assert.ok(reload.loaded >= 128 && reload.loaded < 100000);
		positive(reload.afterAbortMs); assert.ok(reload.afterAbortMs < 200);
	}
	if (workspace) {
		assert.equal(r.environment.desktop.platform, process.platform);
		assert.ok(r.environment.desktop.electron && r.environment.desktop.modules);
		assert.equal(r.phases.reload.stats.totalFiles, 100000);
		assert.equal(reload.state, 'cancelled'); assert.ok(reload.loaded >= 128 && reload.loaded < 100000);
		positive(reload.durationMs); assert.ok(reload.durationMs < 200);
		assert.equal(r.phases.scanCancel.state, 'cancelled'); assert.ok(r.phases.scanCancel.totalMs < 300);
	}
	rows.push(`| ${test.name} | ${(peak / 1024 ** 2).toFixed(1)} | ${r.phases.query.p50Ms.toFixed(1)} | ${r.phases.query.p95Ms.toFixed(1)} | ${cancel.totalMs.toFixed(1)} | ${reload ? (workspace ? reload.durationMs : reload.afterAbortMs).toFixed(1) : '—'} |`);
}
const summary = [`### 100k index stress: ${process.platform} / ${process.arch}`, '',
	`All four cases passed on commit ${report.environment.commit ?? 'local'}; distinct dense vectors, 100000 files/entries per case.`, '',
	'| Case | Peak RSS / renderer MiB | Query P50 ms | Query P95 ms | Query cancel ms | Reload cancel ms |',
	'| --- | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
	'Core/native RSS and renderer working-set peaks are different process scopes; app totals may double-count shared pages.', '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) { await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary); }
console.log(summary);
