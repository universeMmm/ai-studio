/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Main-process command execution
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { isWindows } from '../../../base/common/platform.js';
import { killTree } from '../../../base/node/processes.js';
import { rgDiskPath } from '../../../base/node/ripgrep.js';

export interface AICommandOptions {
	requestId?: string;
	command: string;
	args?: string[];
	cwd?: string;
	shell?: boolean;
	timeout?: number;
	maxBuffer?: number;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export async function runAICommand(opts: AICommandOptions, signal: AbortSignal): Promise<CommandResult> {
	const command = !opts.shell && opts.command === 'rg' ? await rgDiskPath() : opts.command;
	if (signal.aborted) {
		return { stdout: '', stderr: 'Command cancelled', exitCode: -1 };
	}

	const maxBuffer = Math.min(opts.maxBuffer ?? 10 * 1024 * 1024, 10 * 1024 * 1024);
	const child = spawn(command, opts.shell ? [] : opts.args ?? [], {
		cwd: opts.cwd,
		shell: opts.shell ?? false,
		detached: !isWindows, // A POSIX process group lets us stop descendants of shell commands.
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});

	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let stopReason: string | undefined;
		const stop = (reason: string) => {
			if (stopReason || !child.pid) {
				return;
			}
			stopReason = reason;
			if (isWindows) {
				void killTree(child.pid, true).catch(() => child.kill());
			} else {
				try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
			}
		};

		const onAbort = () => stop('Command cancelled');
		signal.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => stop('Command timed out'), opts.timeout ?? 30_000);
		child.stdout.setEncoding('utf8').on('data', (data: string) => {
			stdout += data.slice(0, maxBuffer - stdout.length);
		});
		child.stderr.setEncoding('utf8').on('data', (data: string) => {
			stderr += data.slice(0, maxBuffer - stderr.length);
		});
		child.once('error', err => { stderr = err.message; });
		child.once('close', code => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve({ stdout, stderr: stopReason ?? stderr, exitCode: stopReason ? -1 : code ?? -1 });
		});
	});
}
