/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { IFileService } from '../../files/common/files.js';
import type { ILogService } from '../../log/common/log.js';
import { AgentSandboxSettingId } from '../../sandbox/common/settings.js';
import { TerminalSandboxEngine } from '../../sandbox/common/terminalSandboxEngine.js';
import { WindowsMxcTerminalSandboxRuntime } from '../../sandbox/common/terminalSandboxMxcRuntime.js';
import type { AICommandSandboxContext } from '../common/commandSandbox.js';
import { getAIStudioIpcRenderer } from '../common/desktopIpc.js';

/** Every invocation owns a config and temp directory, including concurrent child agents. */
export async function withAICommandSandbox<T>(command: string, cwd: string, roots: readonly URI[], files: IFileService, log: ILogService, signal: AbortSignal | undefined, readOnly: boolean,
	run: (executable: string, args: string[], sandboxConfig?: string) => Promise<T>): Promise<T> {
	const ipc = getAIStudioIpcRenderer();
	if (!ipc) { throw new Error('Command sandbox requires the desktop process.'); }
	const context = await ipc.invoke<AICommandSandboxContext>('vscode:ai-studio:sandboxContext');
	const temp = URI.file(context.tempDir);
	const windows = context.os === OperatingSystem.Windows;
	const runtime = new WindowsMxcTerminalSandboxRuntime();
	// MXC currently exposes network-enabled setup; retain a block-by-default network policy.
	const createWindowsConfig = runtime.createConfig.bind(runtime);
	const containerId = 'ai-studio-' + generateUuid();
	runtime.createConfig = options => {
		// MXC launches an executable, not a shell expression. Encode the script as UTF-16LE
		// so quotes and metacharacters remain inside the sandboxed PowerShell process.
		const bytes = new Uint8Array(options.command.length * 2);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < options.command.length; i++) { view.setUint16(i * 2, options.command.charCodeAt(i), true); }
		const commandLine = `"${context.shell}" -NoProfile -NonInteractive -EncodedCommand ${encodeBase64(VSBuffer.wrap(bytes))}`;
		return { ...createWindowsConfig({ ...options, command: commandLine, allowNetwork: false }), containerId };
	};
	const engine = new TerminalSandboxEngine({
		getOS: async () => context.os,
		getRuntimeInfo: async () => ({ appRoot: context.appRoot, execPath: context.execPath, runAsNode: true, arch: context.arch }),
		getUserHome: async () => URI.file(context.userHome),
		getSandboxTempDir: async () => temp,
		getWorkspaceStorageReadRoot: async () => undefined,
		getWriteRoots: () => readOnly ? [] : roots,
		onDidChangeRoots: Event.None,
		checkSandboxDependencies: async () => context.dependencies,
		getWindowsMxcFilesystemPolicy: async () => context.windowsPolicy,
		getWindowsMxcEnvironment: async () => context.windowsEnvironment,
		getSandboxSetting: <V>(key: string): V | undefined => {
			if (key === AgentSandboxSettingId.AgentSandboxEnabled) { return 'on' as V; }
			if (key === AgentSandboxSettingId.AgentSandboxWindowsEnabled) { return 'allowNetwork' as V; }
			if (key === AgentSandboxSettingId.AgentSandboxAllowUnsandboxedCommands) { return false as V; }
			if ([AgentSandboxSettingId.AgentSandboxLinuxFileSystem, AgentSandboxSettingId.AgentSandboxMacFileSystem, AgentSandboxSettingId.AgentSandboxWindowsFileSystem].includes(key as AgentSandboxSettingId)) {
				const filesystem = {
					allowRead: roots.map(root => root.fsPath),
					denyWrite: [],
				};
				return filesystem as V;
			}
			return undefined;
		},
		onDidChangeSandboxSettings: Event.None,
	}, files, log, runtime);
	try {
		signal?.throwIfAborted();
		const check = await engine.checkForSandboxingPrereqs();
		if (!check.enabled || check.failedCheck || !check.sandboxConfigPath) {
			throw new Error('Command sandbox is unavailable' + (check.missingDependencies?.length ? ': ' + check.missingDependencies.join(', ') : '.') + ' Command was not executed.');
		}
		const wrapped = await engine.wrapCommand(command, false, windows ? 'powershell.exe' : '/bin/sh', URI.file(cwd));
		if (!wrapped.isSandboxWrapped || wrapped.requiresUnsandboxConfirmation) { throw new Error('Command sandbox refused isolation. Command was not executed.'); }
		signal?.throwIfAborted();
		return await run(context.shell, windows ? ['-NoProfile', '-NonInteractive', '-Command', wrapped.command] : ['-c', wrapped.command], windows ? undefined : await engine.getSandboxConfigPath());
	} finally {
		engine.dispose();
		// Also clean up when prerequisite checks fail before the engine initializes its temp directory.
		try { await files.del(temp, { recursive: true, useTrash: false }); }
		catch { log.warn('[AI command sandbox] Could not remove temporary command directory.'); }
	}
}
