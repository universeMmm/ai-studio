/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { writeDevNLS } from '../devNls.ts';

test('a fresh desktop profile resolves bundled Chinese in source and indexed builds', async t => {
	const repo = path.resolve(import.meta.dirname, '../../..');
	const root = await fs.mkdtemp(path.join(tmpdir(), 'studio-nls-'));
	const out = path.join(root, 'out');
	const previousDev = process.env['VSCODE_DEV'];
	t.after(async () => {
		if (previousDev === undefined) {
			delete process.env['VSCODE_DEV'];
		} else {
			process.env['VSCODE_DEV'] = previousDev;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	await fs.symlink(path.join(repo, 'extensions'), path.join(root, 'extensions'), 'junction');
	await writeDevNLS(out);
	await build({
		entryPoints: { resolver: path.join(repo, 'src/vs/base/node/nls.ts') },
		outdir: out, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }
	});
	const { resolveNLSConfiguration } = await import(pathToFileURL(path.join(out, 'resolver.mjs')).href);
	const context = { userLocale: 'zh-cn', osLocale: 'en-us', nlsMetadataPath: out, userDataPath: path.join(root, 'fresh-profile') };

	process.env['VSCODE_DEV'] = '1';
	const dev = await resolveNLSConfiguration(context);
	assert.equal(dev.resolvedLanguage, 'zh-cn');
	const messages = JSON.parse(await fs.readFile(dev.languagePack.messagesFile, 'utf8'));
	assert.equal(messages['open\u0004Open Folder'], '打开文件夹');
	assert.equal(messages['open\u0004Open Settings'], '打开设置');
	assert.equal(messages['studio.completedWithInput\u0004Completed with input: {0}'], '已完成，输入为：{0}');
	const translations = JSON.parse(await fs.readFile(dev.languagePack.translationsConfigFile, 'utf8'));
	await fs.access(translations['vscode.git']);
	const english = await resolveNLSConfiguration({ ...context, userLocale: 'en-us' });
	assert.equal(english.resolvedLanguage, 'en');
	assert.equal(english.languagePack, undefined);

	delete process.env['VSCODE_DEV'];
	const keys = [
		['vs/platform/menubar/electron-main/menubar', ['mFile']],
		['vs/workbench/contrib/chat/common/model/chatModel', ['studio.ranTerminal', 'untranslated']]
	];
	await fs.writeFile(path.join(out, 'nls.keys.json'), JSON.stringify(keys));
	await fs.writeFile(path.join(out, 'nls.messages.json'), JSON.stringify(['&&File', 'Ran terminal command', 'Fallback']));
	const packaged = await resolveNLSConfiguration({ ...context, commit: 'test-build' });
	assert.deepEqual(JSON.parse(await fs.readFile(packaged.languagePack.messagesFile, 'utf8')), ['文件(&&F)', '已运行终端命令', 'Fallback']);
});
