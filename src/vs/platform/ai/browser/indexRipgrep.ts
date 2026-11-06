/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Shell-free ripgrep for file enumeration and keyword search.
 *--------------------------------------------------------------------------------------------*/

import { getAIStudioIpcRenderer, type AIStudioCommandResult } from '../common/desktopIpc.js';

export async function runIndexRipgrep(args: string[], cwd: string): Promise<string> {
	const ipc = getAIStudioIpcRenderer();
	if (ipc) {
		const result = await ipc.invoke<AIStudioCommandResult>('vscode:ai-studio:exec', { command: 'rg', args, cwd, timeout: 30_000 });
		if (result.exitCode === 0 || result.exitCode === 1) { return result.stdout; }
		throw new Error(result.stderr || 'ripgrep failed');
	}
	const { execFile } = await import('child_process');
	const { rgDiskPath } = await import('../../../base/node/ripgrep.js');
	const binary = await rgDiskPath();
	return new Promise((resolve, reject) => {
		execFile(binary, args, { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
			if (!error || error.code === 1) { resolve(stdout); } else { reject(error); }
		});
	});
}
