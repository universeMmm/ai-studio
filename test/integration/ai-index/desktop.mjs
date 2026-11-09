/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Match scripts/code.{sh,bat}, without invoking a shell or executing a .bat
// file as a binary. In particular, paths with spaces work on Windows.
export async function developmentElectronPath() {
	const product = JSON.parse(await fs.readFile(path.join(root, 'product.json'), 'utf8'));
	const executablePath = path.join(root, '.build/electron', process.platform === 'darwin'
		? `${product.nameLong}.app/Contents/MacOS/${product.nameShort}`
		: process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
	await fs.access(executablePath);
	return executablePath;
}

export async function launchDesktop(workspace, profile, extensions) {
	const executablePath = await developmentElectronPath();
	const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/(TOKEN|API_KEY|SECRET|PASSWORD)/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE'));
	Object.assign(env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ELECTRON_ENABLE_STACK_DUMPING: '1', ELECTRON_ENABLE_LOGGING: '1' });
	return _electron.launch({ executablePath, cwd: root, env, timeout: 90000, args: [
		root, workspace, '--disable-extension=vscode.vscode-api-tests', '--enable-smoke-test-driver',
		'--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates',
		'--use-inmemory-secretstorage', '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
	] });
}
