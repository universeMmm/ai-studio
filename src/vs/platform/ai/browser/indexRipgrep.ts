/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Shell-free ripgrep for file enumeration and keyword search.
 *--------------------------------------------------------------------------------------------*/

import { getAIStudioIpcRenderer, type AIStudioCommandResult } from '../common/desktopIpc.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { abortable } from '../common/indexCancellation.js';
import { INDEX_FILE_LIST_LIMIT } from '../common/indexLimits.js';

export async function runIndexRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const maxBuffer = args[0] === '--files' ? INDEX_FILE_LIST_LIMIT : 10 * 1024 * 1024;
	const ipc = getAIStudioIpcRenderer();
	if (ipc) {
		const requestId = generateUuid();
		const request = ipc.invoke<AIStudioCommandResult>('vscode:ai-studio:exec', { requestId, command: 'rg', args, cwd, timeout: 30_000, maxBuffer });
		const cancel = () => { void ipc.invoke('vscode:ai-studio:cancelExec', requestId).catch(() => { }); };
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			const result = await abortable(request, signal);
			// The command bridge bounds stdout. Never prune from an incomplete file listing.
			if (result.stdoutTruncated || result.stdout.length >= maxBuffer) { throw new Error('ripgrep output limit exceeded'); }
			if (result.exitCode === 0 || result.exitCode === 1) { return result.stdout; }
			throw new Error(result.stderr || 'ripgrep failed');
		} finally { signal?.removeEventListener('abort', cancel); }
	}
	const { execFile } = await import('child_process');
	const { rgDiskPath } = await import('../../../base/node/ripgrep.js');
	const binary = await rgDiskPath();
	return new Promise((resolve, reject) => {
		execFile(binary, args, { cwd, signal, timeout: 30_000, maxBuffer }, (error, stdout) => {
			if (!error || error.code === 1) { resolve(stdout); } else { reject(error); }
		});
	});
}
