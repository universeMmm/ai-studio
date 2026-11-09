/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { runAICommand } from '../../../src/vs/platform/ai/node/commandRunner.js';

suite('Command output budgets', () => {
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
