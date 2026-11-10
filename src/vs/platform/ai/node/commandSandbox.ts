/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, realpath, chmod } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { OS, isWindows } from '../../../base/common/platform.js';
import { SandboxHelperService } from '../../sandbox/node/sandboxHelper.js';
import type { AICommandSandboxContext } from '../common/commandSandbox.js';

/** Resolve runtime paths in the main process, never from tool/model parameters. */
export async function createAICommandSandboxContext(appRoot: string, userHome: string, tmpDir: string): Promise<AICommandSandboxContext> {
	const helper = new SandboxHelperService();
	const [dependencies, windowsPolicy, windowsEnvironment] = await Promise.all([
		helper.checkSandboxDependencies(), helper.getWindowsMxcFilesystemPolicy(), helper.getWindowsMxcEnvironment(),
	]);
	const tempDir = await realpath(await mkdtemp(join(tmpDir, 'ai-studio-sandbox-')));
	if (!isWindows) { await chmod(tempDir, 0o700); }
	return {
		appRoot, execPath: process.execPath, userHome, tempDir, os: OS, arch: process.arch,
		shell: isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh',
		dependencies,
		// Tools may be read, but only the workspace and this command's temp directory are writable.
		windowsPolicy: windowsPolicy && { readonlyPaths: windowsPolicy.readonlyPaths, readwritePaths: [] },
		windowsEnvironment,
	};
}
