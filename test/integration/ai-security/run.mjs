/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../unit/ai/bootstrap.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const built = new URL('../../../.build/test-ai/src/vs/', import.meta.url);
const [{ URI }, { FileService }, { DiskFileSystemProvider }, { NullLogService }, { withAICommandSandbox }, { createAICommandSandboxContext }, { runAICommand }] = await Promise.all([
	'base/common/uri.js', 'platform/files/common/fileService.js', 'platform/files/node/diskFileSystemProvider.js', 'platform/log/common/log.js',
	'platform/ai/browser/commandSandbox.js', 'platform/ai/node/commandSandbox.js', 'platform/ai/node/commandRunner.js',
].map(name => import(new URL(name, built).href)));
const directory = await realpath(await mkdtemp(join(tmpdir(), `ai-security-$(invalid)' space-`)));
const fixtureHome = join(directory, 'home'), workspace = join(fixtureHome, 'workspace');
await mkdir(workspace, { recursive: true });
const log = new NullLogService(), files = new FileService(log), disk = new DiskFileSystemProvider(log);
files.registerProvider('file', disk);
const contexts = [];
const originalBridge = globalThis.vscode;
globalThis.vscode = { ipcRenderer: { async invoke(channel) {
	assert.equal(channel, 'vscode:ai-studio:sandboxContext');
	const context = await createAICommandSandboxContext(repo, fixtureHome, directory);
	contexts.push(context);
	return context;
} } };
const report = { platform: process.platform, arch: process.arch, node: process.version, commit: process.env.GITHUB_SHA, checks: {}, cancellationMs: undefined, pass: false };
const quote = value => process.platform === 'win32' ? `'` + value.replaceAll(`'`, `''`) + `'` : `'` + value.replaceAll(`'`, `'\\''`) + `'`;
const command = script => (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' -e ' + quote(script);
async function run(script, readOnly = false, signal = new AbortController().signal) {
	return withAICommandSandbox(command(script), workspace, [URI.file(workspace)], files, log, signal, readOnly,
		(executable, args, sandboxConfig) => runAICommand({ command: executable, args, cwd: workspace, timeout: 15000, sandboxConfig }, signal));
}
let server;
try {
	let result = await run('require("fs").writeFileSync("inside.txt", "fixture")');
	assert.equal(result.exitCode, 0, result.stderr); assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'fixture');
	report.checks.workspaceWrite = true;
	result = await run('require("fs").writeFileSync("inside.txt", "changed")', true);
	assert.notEqual(result.exitCode, 0); assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'fixture');
	report.checks.automaticCommandsReadOnly = true;
	const outside = join(fixtureHome, 'outside.txt'); await writeFile(outside, 'outside-fixture');
	result = await run('require("fs").writeFileSync(' + JSON.stringify(outside) + ', "changed")');
	assert.notEqual(result.exitCode, 0); assert.equal(await readFile(outside, 'utf8'), 'outside-fixture');
	report.checks.outsideWriteDenied = true;
	result = await run('process.stdout.write(require("fs").readFileSync(' + JSON.stringify(outside) + ', "utf8"))');
	assert.notEqual(result.exitCode, 0); assert.ok(!result.stdout.includes('outside-fixture'));
	report.checks.privateHomeReadDenied = true;
	const previousCanary = process.env.AI_SECURITY_CANARY; process.env.AI_SECURITY_CANARY = 'synthetic-canary';
	try { result = await run('process.stdout.write(process.env.AI_SECURITY_CANARY || "absent")'); }
	finally { if (previousCanary === undefined) { delete process.env.AI_SECURITY_CANARY; } else { process.env.AI_SECURITY_CANARY = previousCanary; } }
	assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout.trim(), 'absent');
	report.checks.environmentCredentialsRemoved = true;
	let reached = 0;
	server = createServer((_request, response) => { reached++; response.end('unexpected'); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	result = await run('const r=require("http").get("http://127.0.0.1:' + port + '",()=>process.exit(9));r.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),1500)');
	assert.equal(reached, 0); assert.equal(result.exitCode, 0, result.stderr);
	report.checks.networkDenied = true;
	const controller = new AbortController(); let timer;
	let cancelledAt;
	try {
		result = await withAICommandSandbox(command('setInterval(()=>{},1000)'), workspace, [URI.file(workspace)], files, log, controller.signal, false, (executable, args, sandboxConfig) => {
			timer = setTimeout(() => { cancelledAt = performance.now(); controller.abort(); }, 1000);
			return runAICommand({ command: executable, args, cwd: workspace, timeout: 15000, sandboxConfig }, controller.signal);
		});
	} finally { clearTimeout(timer); }
	report.cancellationMs = performance.now() - cancelledAt;
	assert.equal(result.exitCode, -1); assert.ok(report.cancellationMs < 3000);
	report.checks.cancellation = true;
	for (const context of contexts) { assert.equal(await files.exists(URI.file(context.tempDir)), false); }
	report.checks.temporaryDirectoriesRemoved = true;
	report.pass = true;
} catch (error) {
	report.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
} finally {
	if (server) { await new Promise(resolve => server.close(resolve)); }
	globalThis.vscode = originalBridge; files.dispose(); disk.dispose();
	await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	const output = join(repo, '.build/ai-security'); await mkdir(output, { recursive: true });
	await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
}
