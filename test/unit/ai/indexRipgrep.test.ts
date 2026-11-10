/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { runIndexRipgrep } from '../../../src/vs/platform/ai/browser/indexRipgrep.js';
import type { AIStudioIpcRenderer } from '../../../src/vs/platform/ai/common/desktopIpc.js';

suite('Index ripgrep bridge', () => {
	const global = globalThis as typeof globalThis & { vscode?: { ipcRenderer?: AIStudioIpcRenderer } };
	let previous: typeof global.vscode;
	setup(() => { previous = global.vscode; });
	teardown(() => { global.vscode = previous; });

	test('cancels the matching main-process command and stops waiting immediately', async () => {
		const calls: { channel: string; value: unknown }[] = [];
		global.vscode = {
			ipcRenderer: {
				invoke: <T>(channel: string, value: unknown) => {
					calls.push({ channel, value });
					return channel.endsWith(':exec') ? new Promise<T>(() => { }) : Promise.resolve(undefined as T);
				}
			}
		};
		const controller = new AbortController();
		const result = runIndexRipgrep(['--files'], '/workspace', controller.signal);
		controller.abort(); await assert.rejects(result, { name: 'AbortError' });
		assert.equal(calls[1].channel, 'vscode:ai-studio:cancelExec');
		assert.equal(calls[1].value, (calls[0].value as { requestId: string }).requestId);
	});
	test('rejects truncated enumeration rather than treating it as deleted files', async () => {
		global.vscode = { ipcRenderer: { invoke: async <T>() => ({ stdout: 'partial\0', stderr: '', exitCode: 0, stdoutTruncated: true }) as T } };
		await assert.rejects(runIndexRipgrep(['--files'], '/workspace'), /output limit/);
	});
	test('large listings request a bounded larger buffer while keyword output stays bounded', async () => {
		const output = 'a'.repeat(12 * 1024 * 1024) + '\0';
		let budget = 0;
		global.vscode = { ipcRenderer: { invoke: async <T>(_channel: string, options: unknown) => { budget = (options as { maxBuffer: number }).maxBuffer; return { stdout: output, stderr: '', exitCode: 0 } as T; } } };
		assert.equal(await runIndexRipgrep(['--files'], '/workspace'), output);
		assert.equal(budget, 64 * 1024 * 1024);
		await assert.rejects(runIndexRipgrep(['--line-number'], '/workspace'), /output limit/);
		assert.equal(budget, 10 * 1024 * 1024);
	});
});
