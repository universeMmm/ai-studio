/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sign } from '@electron/osx-sign';

const root = path.resolve(import.meta.dirname, '../..');
const product = JSON.parse(await readFile(path.join(root, 'product.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const releaseVersion = args.find(arg => arg.startsWith('--version='))?.slice('--version='.length) ?? manifest.version;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
	throw new Error('Build the macOS package on an Apple Silicon or Intel Mac.');
}
if (!/^[\w.-]+$/.test(releaseVersion)) {
	throw new Error('Invalid release version.');
}
for (const arg of args) {
	if (arg !== '--skip-build' && !arg.startsWith('--version=')) {
		throw new Error(`Unknown argument: ${arg}`);
	}
}

function run(command: string, commandArgs: string[], env = process.env): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', env });
		child.on('error', reject);
		child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
	});
}

const appName = `${product.nameLong}.app`;
const app = path.resolve(root, `../VSCode-darwin-${process.arch}`, appName);
const output = path.join(root, '.build/release');
const filename = `AI-Studio-${releaseVersion}-macOS-${process.arch}.dmg`;
const dmg = path.join(output, filename);
await mkdir(output, { recursive: true });
await access(dmg).then(() => { throw new Error(`Refusing to overwrite ${dmg}`); }, () => undefined);
if (!args.includes('--skip-build')) {
	await run('npm', ['run', 'gulp', '--', `vscode-darwin-${process.arch}-min`], { ...process.env, CI: '1' });
}
await access(path.join(app, 'Contents/Resources/app/out/main.js'));

// Reuse Electron's signing implementation to sign nested frameworks and helpers.
// Ad-hoc signing makes local ARM64 builds runnable; it is not Developer ID notarization.
const identity = process.env['CODESIGN_IDENTITY'] || '-';
await sign({
	app,
	platform: 'darwin',
	identity,
	identityValidation: identity !== '-',
	preAutoEntitlements: false,
	preEmbedProvisioningProfile: false,
	optionsForFile(file) {
		let name = 'app';
		if (file.includes(' Helper (GPU).app')) { name = 'helper-gpu'; }
		else if (file.includes(' Helper (Renderer).app')) { name = 'helper-renderer'; }
		else if (file.includes(' Helper (Plugin).app')) { name = 'helper-plugin'; }
		else if (file.includes(' Helper.app')) { name = 'helper'; }
		return {
			entitlements: path.join(root, 'build/azure-pipelines/darwin', `${name}-entitlements.plist`),
			hardenedRuntime: identity !== '-',
			timestamp: identity === '-' ? 'none' : undefined,
		};
	},
});

const stage = await mkdtemp(path.join(os.tmpdir(), 'ai-studio-dmg-'));
try {
	await run('/usr/bin/ditto', [app, path.join(stage, appName)]);
	await symlink('/Applications', path.join(stage, 'Applications'));
	await run('/usr/bin/hdiutil', ['create', '-volname', product.nameLong, '-srcfolder', stage, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
	await run('/usr/bin/hdiutil', ['verify', dmg]);
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(dmg)) { hash.update(chunk); }
	await writeFile(`${dmg}.sha256`, `${hash.digest('hex')}  ${filename}\n`);
	console.log(`Created ${dmg}\nSigning: ${identity === '-' ? 'ad-hoc (not notarized)' : 'Developer ID (notarization is a separate step)'}`);
} finally {
	await rm(stage, { recursive: true, force: true });
}
