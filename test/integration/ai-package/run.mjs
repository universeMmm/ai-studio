/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { _electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.build/ai-package');
await fs.mkdir(output, { recursive: true });
const launchedAt = Date.now();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-packaged-'));
const workspace = path.join(tmp, 'workspace'), profile = path.join(tmp, 'profile');
await fs.mkdir(workspace); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
await fs.writeFile(path.join(workspace, 'sample.txt'), 'PACKAGED_TOOL_EVIDENCE');
const checks = [], errors = [], requests = [];
const server = http.createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*'); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); res.setHeader('Access-Control-Allow-Private-Network', 'true');
	if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
	const chunks = []; for await (const c of req) { chunks.push(c); }
	const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
	if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-5.2' }, { id: 'gpt-5-mini' }] })); return; }
	if (req.url === '/v1/embeddings') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })); return; }
	if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
	requests.push({ model: b.model, toolCount: b.tools?.length });
	res.setHeader('Content-Type', 'text/event-stream');
	const toolResponse = b.messages?.find(m => m.role === 'tool');
	const delta = toolResponse ? { content: JSON.stringify(toolResponse).includes('PACKAGED_TOOL_EVIDENCE') ? '安装包工具验证通过。' : '安装包工具验证失败。' } : { tool_calls: [{ index: 0, id: 'package_read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) } }] };
	res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: toolResponse ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'ai.modelId': 'gpt-5.2', 'ai.modelName': 'Package model', 'ai.apiType': 'openai', 'ai.apiBase': endpoint, 'ai.apiKey': 'synthetic-package-test', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }));
await fs.writeFile(path.join(profile, 'User/chatLanguageModels.json'), JSON.stringify([{ vendor: 'ai-studio', name: 'Package model', settings: { 'Package model': { modelId: 'gpt-5.2', apiType: 'openai', endpoint } } }]));
let app, page, stage = 'launch';
try {
	const env = { ...process.env }; for (const k of ['VSCODE_DEV', 'VSCODE_CLI', 'NODE_ENV', 'ELECTRON_RUN_AS_NODE']) { delete env[k]; }
	app = await _electron.launch({ executablePath: process.env.STUDIO_TEST_APP || path.resolve(root, '../VSCode-darwin-' + process.arch + '/AI Studio.app/Contents/MacOS/AI Studio'), cwd: tmp, args: [workspace, '--enable-smoke-test-driver', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--use-inmemory-secretstorage', '--user-data-dir=' + profile, '--extensions-dir=' + path.join(tmp, 'extensions')], env, timeout: 90000 });
	page = await app.firstWindow({ timeout: 60000 }); page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') { console.log('Renderer:', m.text()); } }); page.on('requestfailed', r => console.log('Request failed:', r.url(), r.failure()));
	page.setDefaultTimeout(20000); await page.locator('.studio-new-button').waitFor();
	checks.push('Independent packaged application startup');
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 800));
	const actual = await app.evaluate(async ({ app, session }) => { const reference = session.fromPartition('release-system-check', { cache: false }); await reference.setProxy({ mode: 'system' }); return { packaged: app.isPackaged, actualPath: app.getAppPath(), nls: JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'), system: await reference.resolveProxy('https://www.iana.org'), active: await session.defaultSession.resolveProxy('https://www.iana.org') }; });
	assert.equal(actual.packaged, true); assert.equal(actual.system, actual.active); checks.push('Packaged Electron session follows system proxy');
	stage = 'chat'; await page.locator('.studio-new-button').click();
	const ed = page.locator('.studio-thread .interactive-input-part .monaco-editor').first(); await ed.click(); await ed.locator('textarea:visible, .native-edit-context:visible').first().focus(); await page.keyboard.insertText('请读取 sample.txt 并报告验证结果。'); await page.keyboard.press('Enter');
	await page.getByText('安装包工具验证通过。', { exact: false }).last().waitFor({ timeout: 60000 });
	checks.push('Packaged model streaming and real read_file tool');
	stage = 'menus'; await page.locator('.studio-new-button').click();
	await page.locator('.studio-thread .studio-model-picker .model-picker-name:visible').last().click();
	const slider = page.getByRole('slider', { name: '推理强度' });
	await slider.waitFor();
	await slider.focus(); await page.keyboard.press('End');
	// updatePlaybackRate commits on the next animation frame.
	await page.waitForFunction(() => {
		const animations = document.querySelector('.studio-reasoning-fill')?.getAnimations({ subtree: true }).filter(a => a.animationName === 'studio-reasoning-flow') ?? [];
		return animations.length > 0 && animations.every(a => a.playbackRate > 1);
	}, undefined, { timeout: 5000 });
	const motion = await page.locator('.studio-reasoning-fill').evaluate(fill => fill.getAnimations({ subtree: true }).filter(a => a.animationName === 'studio-reasoning-flow').map(a => a.playbackRate));
	assert.ok(motion.length > 0 && motion.every(rate => rate > 1));
	await page.keyboard.press('Escape');
	checks.push('Reasoning popover and accelerated fill animation');
	await page.locator('.studio-settings-button:visible').click();
	const settings = page.locator('.studio-settings-editor:visible'); await settings.waitFor(); assert.equal(await settings.locator('select').count(), 0); checks.push('Friendly settings without native dropdowns');
	await settings.getByRole('button', { name: '管理模型', exact: true }).click();
	await page.locator('.model-configuration-editor:visible').waitFor();
	checks.push('Packaged model configuration view');
	await page.locator('.model-configuration-fetch-models').click();
	await page.locator('.model-configuration-model-id-trigger:visible').waitFor();
	await page.locator('.model-configuration-model-id-trigger:visible').click();
	const modelOption = page.locator('.studio-model-id-menu-item').filter({ hasText: 'gpt-5-mini' });
	const bounds = await modelOption.boundingBox(); assert.ok(bounds);
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 3 });
	await modelOption.click();
	assert.match(await page.locator('.model-configuration-model-id-trigger').innerText(), /gpt-5-mini/);
	assert.equal(await page.locator('.model-configuration-editor select').count(), 0);
	checks.push('Model discovery uses application dropdown');
	stage = 'language-cache';
	await page.waitForTimeout(Math.max(0, launchedAt + 47000 - Date.now()));
	assert.ok(actual.nls.languagePack?.messagesFile, 'Bundled Chinese translation cache must be active');
	await fs.access(actual.nls.languagePack.messagesFile);
	const logRoot = path.join(profile, 'logs');
	const logFiles = await fs.readdir(logRoot, { recursive: true });
	for (const log of logFiles.filter(f => f.endsWith('sharedprocess.log'))) { assert.doesNotMatch(await fs.readFile(path.join(logRoot, log), 'utf8'), /uncaught exception/i); }
	checks.push('Bundled Chinese cache survives scheduled cleanup');
	await page.screenshot({ path: path.join(output, 'packaged-models.png') });
	assert.deepEqual(errors, []); checks.push('No renderer exceptions');
	await fs.writeFile(path.join(output, 'packaged-report.json'), JSON.stringify({ success: true, checks, requests, errors, actual, tmp }, null, 2));
	console.log(JSON.stringify({ success: true, checks, requests, errors, tmp }, null, 2));
} catch (e) { if (page) { await page.screenshot({ path: path.join(output, 'packaged-failure.png') }).catch(() => { }); } await fs.writeFile(path.join(output, 'packaged-report.json'), JSON.stringify({ success: false, stage, error: String(e), checks, requests, errors, tmp }, null, 2)); throw e; }
finally { if (app) { await app.close().catch(() => { }); } await new Promise(r => server.close(r)); }
