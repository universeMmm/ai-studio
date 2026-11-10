/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAICommandEnvironment, runAICommand } from '../../../src/vs/platform/ai/node/commandRunner.js';

suite('Command output budgets', () => {
	test('invalid or missing sandbox configuration prevents subprocess launch', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ai-invalid-sandbox-'));
		const sandboxConfig = join(directory, 'config.json');
		try {
			for (const config of ['{}', '{malformed']) {
				await writeFile(sandboxConfig, config);
				await assert.rejects(runAICommand({ command: process.execPath, args: ['-e', 'process.stdout.write("must not execute")'], sandboxConfig }, new AbortController().signal), /Invalid command sandbox configuration/);
			}
			await rm(sandboxConfig);
			await assert.rejects(runAICommand({ command: process.execPath, sandboxConfig }, new AbortController().signal), /Invalid command sandbox configuration/);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
	test('subprocess environments exclude credentials and interpreter startup hooks', () => {
		const env = getAICommandEnvironment({ PATH: '/usr/bin', HOME: '/home/fixture', OPENAI_API_KEY: 'fixture', GITHUB_TOKEN: 'fixture', NODE_OPTIONS: '--require=evil.js', BASH_ENV: 'evil.sh', PYTHONPATH: '/evil', GIT_CONFIG_COUNT: '1' });
		assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/fixture' });
	});
	test('counts UTF-8 bytes and marks truncated output without emitting a broken character', async () => {
		const result = await runAICommand({ command: process.execPath, args: ['-e', 'process.stdout.write("你好世界")'], maxBuffer: 5 }, new AbortController().signal);
		assert.equal(result.exitCode, 0); assert.equal(result.stdout, '你'); assert.equal(result.stdoutTruncated, true);
	});
	test('the larger file-list allowance does not increase normal command budgets', async () => {
		const result = await runAICommand({ command: process.execPath, args: ['-e', 'process.stdout.write("a".repeat(12 * 1024 * 1024))'], maxBuffer: 64 * 1024 * 1024 }, new AbortController().signal);
		assert.equal(result.stdout.length, 10 * 1024 * 1024); assert.equal(result.stdoutTruncated, true);
	});
	test('invalid negative output budgets cannot retain arbitrary output', async () => {
		const result = await runAICommand({ command: process.execPath, args: ['-e', 'process.stdout.write("bounded")'], maxBuffer: -1 }, new AbortController().signal);
		assert.equal(result.stdout, ''); assert.equal(result.stdoutTruncated, true);
	});
});
