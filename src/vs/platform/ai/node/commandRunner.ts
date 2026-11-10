/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Main-process command execution
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { isWindows } from '../../../base/common/platform.js';
import { killTree } from '../../../base/node/processes.js';
import { rgDiskPath } from '../../../base/node/ripgrep.js';
import { INDEX_FILE_LIST_LIMIT } from '../common/indexLimits.js';

/** Do not expose model keys or shell/runtime injection variables to tool subprocesses. */
export function getAICommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'USER', 'LOGNAME', 'ELECTRON_RUN_AS_NODE']);
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
}

export interface AICommandOptions {
	requestId?: string;
	command: string;
	args?: string[];
	cwd?: string;
	shell?: boolean;
	timeout?: number;
	maxBuffer?: number;
	/** SRT configuration to validate before launching its CLI (which otherwise falls back). */
	sandboxConfig?: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	stdoutTruncated?: boolean;
}

export async function runAICommand(opts: AICommandOptions, signal: AbortSignal): Promise<CommandResult> {
	if (opts.sandboxConfig) {
		// The runtime CLI falls back to defaults on malformed JSON/schema. Fail closed instead.
		const { SandboxRuntimeConfigSchema } = await import('@vscode/sandbox-runtime');
		try {
			SandboxRuntimeConfigSchema.parse(JSON.parse(await readFile(opts.sandboxConfig, 'utf8')));
		} catch {
			throw new Error('Invalid command sandbox configuration. Command was not executed.');
		}
	}
	const command = !opts.shell && opts.command === 'rg' ? await rgDiskPath() : opts.command;
	if (signal.aborted) {
		return { stdout: '', stderr: 'Command cancelled', exitCode: -1 };
	}

	const limit = !opts.shell && opts.command === 'rg' && opts.args?.[0] === '--files' ? INDEX_FILE_LIST_LIMIT : 10 * 1024 * 1024;
	const requested = typeof opts.maxBuffer === 'number' && Number.isFinite(opts.maxBuffer) ? Math.max(0, Math.floor(opts.maxBuffer)) : 10 * 1024 * 1024;
	const maxBuffer = Math.min(requested, limit);
	const child = spawn(command, opts.shell ? [] : opts.args ?? [], {
		env: getAICommandEnvironment(),
		cwd: opts.cwd,
		shell: opts.shell ?? false,
		detached: !isWindows, // A POSIX process group lets us stop descendants of shell commands.
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});

	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0, stderrBytes = 0;
		let stdoutTruncated = false;
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
			const size = Buffer.byteLength(data), remaining = maxBuffer - stdoutBytes;
			stdoutTruncated ||= size > remaining;
			if (remaining <= 0) { return; }
			stdout += size <= remaining ? data : new StringDecoder('utf8').write(Buffer.from(data).subarray(0, remaining));
			stdoutBytes += Math.min(size, remaining);
		});
		child.stderr.setEncoding('utf8').on('data', (data: string) => {
			const size = Buffer.byteLength(data), remaining = maxBuffer - stderrBytes;
			if (remaining <= 0) { return; }
			stderr += size <= remaining ? data : new StringDecoder('utf8').write(Buffer.from(data).subarray(0, remaining));
			stderrBytes += Math.min(size, remaining);
		});
		child.once('error', err => { stderr = err.message; });
		child.once('close', code => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve({ stdout, stderr: stopReason ?? stderr, exitCode: stopReason ? -1 : code ?? -1, ...(stdoutTruncated ? { stdoutTruncated: true } : {}) });
		});
	});
}
