/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const report = JSON.parse(await fs.readFile('.build/ui-redesign/studio-index-runtime-report.json', 'utf8'));
assert.equal(report.pass, true, JSON.stringify(report.failure));
assert.equal(report.environment.platform, process.platform);
assert.equal(report.native.environment.platform, process.platform);
assert.ok(report.native.environment.electron && report.native.environment.modules);
if (process.env.GITHUB_SHA) { assert.equal(report.environment.commit, process.env.GITHUB_SHA, 'report belongs to another commit'); }
assert.ok(Object.values(report.checks).every(value => value === true));
const rows = { ...report.measurements, ...report.native.measurements };
const summary = [
	`### Index regression: ${process.platform} / ${process.arch}`,
	'',
	`${Object.keys(report.checks).length} checks passed. Electron ${report.native.environment.electron}, native ABI ${report.native.environment.modules}.`,
	'', '| Measurement | Value |', '| --- | ---: |',
	...Object.entries(rows).map(([name, value]) => `| ${name} | ${Number(value).toFixed(2)} |`), '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) { await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary); }
console.log(summary);
