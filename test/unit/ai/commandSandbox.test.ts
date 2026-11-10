/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { OperatingSystem } from '../../../src/vs/base/common/platform.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { FileService } from '../../../src/vs/platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../src/vs/platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { withAICommandSandbox } from '../../../src/vs/platform/ai/browser/commandSandbox.js';
import type { AICommandSandboxContext } from '../../../src/vs/platform/ai/common/commandSandbox.js';
import type { AIStudioIpcRenderer } from '../../../src/vs/platform/ai/common/desktopIpc.js';

suite('AI command sandbox policy', () => {
	const globals = globalThis as typeof globalThis & { vscode?: { ipcRenderer?: AIStudioIpcRenderer } };
	const root = URI.file('/workspace');
	let previous: typeof globals.vscode;
	let files: FileService;
	let provider: InMemoryFileSystemProvider;
	let context: AICommandSandboxContext;
	const log = new NullLogService();
	setup(async () => {
		files = new FileService(log); provider = new InMemoryFileSystemProvider(); files.registerProvider('file', provider);
		files.realpath = async uri => uri;
		await files.createFolder(root);
		context = { appRoot: '/app', execPath: '/app/node', userHome: '/home', tempDir: '/tmp/command', os: OperatingSystem.Macintosh, arch: 'arm64', shell: '/bin/sh' };
		previous = globals.vscode;
		globals.vscode = { ipcRenderer: { invoke: async <T>(channel: string) => { assert.equal(channel, 'vscode:ai-studio:sandboxContext'); return context as T; } } };
	});
	teardown(() => { globals.vscode = previous; files.dispose(); provider.dispose(); });

	test('automatic commands receive read-only workspace access and a blocked network', async () => {
		await withAICommandSandbox('pwd', root.fsPath, [root], files, log, undefined, true, async (command, args, sandboxConfig) => {
			assert.equal(command, '/bin/sh'); assert.ok(args[1].includes('sandbox-runtime'));
			assert.ok(sandboxConfig);
			const directory = await files.resolve(URI.file(context.tempDir));
			const config = JSON.parse((await files.readFile(directory.children![0].resource)).value.toString());
			assert.deepEqual(config.network.allowedDomains, []);
			assert.ok(config.filesystem.allowRead.includes(root.fsPath));
			assert.ok(!config.filesystem.allowWrite.includes(root.fsPath));
		});
		assert.equal(await files.exists(URI.file(context.tempDir)), false);
	});

	test('missing Linux prerequisites prevent execution and clean temporary state', async () => {
		context.os = OperatingSystem.Linux;
		context.dependencies = { bubblewrapInstalled: false, socatInstalled: false };
		let executed = false;
		await assert.rejects(withAICommandSandbox('echo hello', root.fsPath, [root], files, log, undefined, false, async () => { executed = true; }), /bubblewrap/);
		assert.equal(executed, false); assert.equal(await files.exists(URI.file(context.tempDir)), false);
	});

	test('cancellation before wrapping never invokes the command and cleans its directory', async () => {
		await files.createFolder(URI.file(context.tempDir));
		const controller = new AbortController(); controller.abort();
		await assert.rejects(withAICommandSandbox('echo hello', root.fsPath, [root], files, log, controller.signal, false, async () => assert.fail('must not execute')), { name: 'AbortError' });
		assert.equal(await files.exists(URI.file(context.tempDir)), false);
	});

	test('Windows MXC uses block-by-default networking and no profile startup', async () => {
		context.os = OperatingSystem.Windows; context.shell = 'powershell.exe';
		context.windowsPolicy = { readonlyPaths: ['C:\\Windows'], readwritePaths: [] }; context.windowsEnvironment = ['PATH=C:\\Windows'];
		await withAICommandSandbox('echo hello', root.fsPath, [root], files, log, undefined, false, async (command, args) => {
			assert.equal(command, 'powershell.exe'); assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
			const directory = await files.resolve(URI.file(context.tempDir));
			const config = JSON.parse((await files.readFile(directory.children![0].resource)).value.toString());
			assert.equal(config.network.defaultPolicy, 'block');
			assert.match(config.containerId, /^ai-studio-[a-f\d-]+$/);
			assert.match(config.process.commandLine, /-NoProfile -NonInteractive -EncodedCommand /);
			assert.equal(Buffer.from(config.process.commandLine.split(' ').at(-1), 'base64').toString('utf16le'), 'echo hello');
			assert.ok(config.filesystem.readwritePaths.every((path: string) => /workspace|tmp[\\/]command/.test(path)));
		});
	});
});
