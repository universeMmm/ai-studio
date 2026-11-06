/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'ai-studio-network-'));
const profile = path.join(temp, 'profile');
const workspace = path.join(temp, 'workspace');
const output = path.resolve(root, process.env.AI_NETWORK_REPORT || '.build/ai-network/report.json');
const publicUrl = 'https://www.iana.org/help/example-domains';
const marker = 'ai-network-origin-fixture';
const report = { platform: process.platform, arch: process.arch, checks: [], pass: false };
const sockets = new Set();
let originHits = 0;
let rejectedHits = 0;
const proxyHits = { A: 0, B: 0 };
let proxyAAddress;
let proxyBAddress;

function server(handler) {
	const result = http.createServer(handler);
	result.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
	return result;
}
function cors(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
const origin = server(async (req, res) => {
	cors(req, res);
	if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
	if (req.url === '/a.pac' || req.url === '/b.pac') {
		const proxy = req.url === '/a.pac' ? proxyAAddress : proxyBAddress;
		res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' });
		res.end(`function FindProxyForURL(url, host) { if (host === "localhost") return "DIRECT"; return "PROXY ${proxy}"; }`);
		return;
	}
	originHits++;
	if (req.url === '/chat/completions' || req.url === '/embeddings') {
		let raw = '';
		for await (const part of req) { raw += part; }
		const body = JSON.parse(raw);
		assert.equal(req.headers.authorization, 'Bearer synthetic-network-test-key');
		if (req.url === '/embeddings') {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }));
		} else {
			assert.equal(body.model, 'network-fixture');
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: marker } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
		}
		return;
	}
	res.writeHead(200, { 'Content-Type': 'text/plain' }).end(marker);
});
const rejecting = server((_req, res) => { rejectedHits++; res.writeHead(502).end('blocked'); });
rejecting.on('connect', (_req, socket) => { rejectedHits++; socket.end('HTTP/1.1 502 Blocked\r\nConnection: close\r\n\r\n'); });
const makeProxy = label => server((req, res) => {
	cors(req, res);
	if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
	proxyHits[label]++;
	res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('proxy-' + label);
});
const proxyA = makeProxy('A');
const proxyB = makeProxy('B');
const servers = [origin, rejecting, proxyA, proxyB];
async function listen(target) {
	await new Promise((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve));
	return '127.0.0.1:' + target.address().port;
}
async function within(promise, ms, label) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]); }
	finally { clearTimeout(timer); }
}
function passed(name, details = {}) { report.checks.push({ name, ...details, pass: true }); }
let electron;
try {
	const [originAddress, rejectingAddress, a, b] = await Promise.all(servers.map(listen));
	proxyAAddress = a; proxyBAddress = b;
	const localUrl = 'http://' + originAddress;
	await mkdir(workspace);
	await mkdir(path.join(profile, 'User'), { recursive: true });
	await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
		'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
		'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
		'http.proxy': 'http://' + rejectingAddress, 'http.noProxy': ['*'], 'http.proxySupport': 'off',
		'http.useLocalProxyConfiguration': false, 'http.electronFetch': false,
	}));
	const env = { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' };
	// macOS/Windows system settings must take precedence over inherited shell proxy variables.
	if (process.platform !== 'linux') {
		for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) { env[key] = 'http://' + rejectingAddress; }
		env.NO_PROXY = env.no_proxy = '*';
	}
	electron = await _electron.launch({
		executablePath: path.join(root, 'scripts/code.sh'),
		args: [workspace, '--enable-smoke-test-driver', '--skip-welcome', '--skip-release-notes', '--disable-extensions',
			'--disable-telemetry', '--disable-updates', '--use-inmemory-secretstorage', '--user-data-dir=' + profile,
			'--extensions-dir=' + path.join(temp, 'extensions')],
		env, timeout: 90000,
	});
	const page = await electron.firstWindow({ timeout: 45000 });
	await page.locator('.monaco-workbench .part.editor').first().waitFor({ state: 'visible', timeout: 45000 });
	const routes = await electron.evaluate(async ({ app, session, BrowserWindow }, { publicUrl, localUrl }) => {
		const reference = session.fromPartition('network-test-system-reference', { cache: false });
		await reference.setProxy({ mode: 'system' });
		const actual = session.defaultSession;
		const window = BrowserWindow.getAllWindows()[0].webContents.session;
		const expected = await reference.resolveProxy(publicUrl);
		const expectedLocal = await reference.resolveProxy(localUrl);
		return {
			publicKind: expected.split(/[ ;]/)[0], localKind: expectedLocal.split(/[ ;]/)[0],
			windowUsesDefaultSession: actual === window,
			rendererMatchesSystem: await window.resolveProxy(publicUrl) === expected,
			mainMatchesSystem: await actual.resolveProxy(publicUrl) === expected,
			utilityMatchesSystem: await app.resolveProxy(publicUrl) === expected,
			localMatchesSystem: await actual.resolveProxy(localUrl) === expectedLocal,
		};
	}, { publicUrl, localUrl });
	assert.ok(routes.windowUsesDefaultSession && routes.rendererMatchesSystem && routes.mainMatchesSystem && routes.utilityMatchesSystem && routes.localMatchesSystem);
	if (process.argv.includes('--require-system-proxy')) { assert.notEqual(routes.publicKind, 'DIRECT', 'this run requires an active OS proxy'); }
	passed('default session follows actual OS policy despite conflicting application settings', routes);
	await page.evaluate(async () => {
		const base = window.location.href.split('/out/')[0] + '/out/';
		const { ToolExecutor } = await import(base + 'vs/platform/ai/browser/toolExecutor.js');
		const { WorkbenchContributionsRegistry } = await import(base + 'vs/workbench/common/contributions.js');
		const { CustomProvider } = await import(base + 'vs/platform/ai/common/customProvider.js');
		const tool = WorkbenchContributionsRegistry.INSTANCE.instantiationService.createInstance(ToolExecutor);
		globalThis.networkTestFetch = url => tool.execute('web_fetch', { url, prompt: 'Retrieve the page text' });
		globalThis.networkTestSearch = () => tool.execute('web_search', { query: 'IANA example domains', num_results: 5 });
		globalThis.networkTestModel = async endpoint => {
			const provider = new CustomProvider(endpoint, 'synthetic-network-test-key', 'network-fixture', tool.logService);
			try {
				let text = '';
				await new Promise((resolve, reject) => provider.streamChat([{ role: 'user', content: 'network fixture' }], [], {}, {
					onToken: token => text += token, onToolUse() { }, onDone: resolve, onError: reject,
				}));
				return { text, embeddings: await provider.embed(['network fixture']) };
			} finally { provider.dispose(); }
		};
	});
	const fetched = await within(page.evaluate(url => globalThis.networkTestFetch(url), publicUrl), 35000, 'public WebFetch');
	assert.match(fetched, /RFC\s*2606/i);
	passed('production WebFetch main-process net.request reaches IANA');
	const search = await within(page.evaluate(() => globalThis.networkTestSearch()), 45000, 'public WebSearch');
	const official = [...search.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].some(match => /(^|\.)iana\.org$/i.test(new URL(match[1]).hostname));
	assert.ok(official, 'WebSearch must return an official IANA result: ' + search.slice(0, 220));
	passed('production WebSearch main-process net.fetch returns IANA', { provider: /^Source: (.+)$/m.exec(search)?.[1] });
	const model = await within(page.evaluate(url => globalThis.networkTestModel(url), localUrl), 15000, 'renderer model');
	assert.deepEqual(model, { text: marker, embeddings: [[0.25, 0.75]] });
	assert.equal(rejectedHits, 0, 'production requests must not use the conflicting application or shell proxy');
	passed('production renderer model streaming and embedding use system-routed session', { syntheticCredentialsOnly: true });

	// All mutations below are confined to an ephemeral partition in the temporary application.
	const partition = 'network-test-isolated-' + Date.now();
	await electron.evaluate(async ({ BrowserWindow, session }, partition) => {
		const isolated = session.fromPartition(partition, { cache: false });
		const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true } });
		await window.loadURL('data:text/html,<title>Proxy integration fixture</title>');
		globalThis.networkTestIsolated = { isolated, window };
	}, partition);
	const setProxy = config => electron.evaluate(async (_electron, config) => {
		const { isolated } = globalThis.networkTestIsolated;
		await isolated.setProxy(config);
		await isolated.closeAllConnections();
		await isolated.forceReloadProxyConfig();
	}, config);
	const requestAll = url => within(electron.evaluate(async ({ net }, url) => {
		const { isolated, window } = globalThis.networkTestIsolated;
		const request = () => new Promise((resolve, reject) => {
			const req = net.request({ url, session: isolated });
			req.on('error', reject);
			req.on('response', response => {
				let text = ''; response.on('data', chunk => text += chunk);
				response.on('end', () => resolve(text)); response.on('error', reject);
			});
			req.end();
		});
		const results = await Promise.allSettled([
			isolated.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) }).then(response => response.text()),
			request(),
			window.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, {cache:'no-store',signal:AbortSignal.timeout(6000)}).then(r=>r.text())`),
		]);
		return results.map(result => result.status === 'fulfilled' ? { ok: true, body: result.value } : { ok: false });
	}, url), 10000, 'isolated transports');
	const fixture = 'http://proxy-network-fixture.invalid/probe';
	await setProxy({ mode: 'pac_script', pacScript: localUrl + '/a.pac', pacScriptMandatory: true });
	assert.deepEqual(await requestAll(fixture), Array(3).fill({ ok: true, body: 'proxy-A' }));
	passed('PAC routes renderer fetch, main fetch and net.request through proxy A');
	await setProxy({ mode: 'pac_script', pacScript: localUrl + '/b.pac', pacScriptMandatory: true });
	assert.deepEqual(await requestAll(fixture), Array(3).fill({ ok: true, body: 'proxy-B' }));
	passed('PAC change is observed by all three transports');
	const beforeBypass = { ...proxyHits };
	assert.deepEqual(await requestAll(localUrl.replace('127.0.0.1', 'localhost') + '/direct'), Array(3).fill({ ok: true, body: marker }));
	assert.deepEqual(proxyHits, beforeBypass);
	passed('PAC DIRECT exception reaches local origin without a proxy');
	await setProxy({ mode: 'fixed_servers', proxyRules: proxyAAddress, proxyBypassRules: '<-loopback>;127.0.0.1' });
	assert.deepEqual(await requestAll(localUrl + '/bypass'), Array(3).fill({ ok: true, body: marker }));
	passed('explicit proxy bypass rule is respected by all three transports');
	const dead = server((_req, res) => res.end());
	const deadAddress = await listen(dead);
	await new Promise(resolve => dead.close(resolve));
	await setProxy({ mode: 'fixed_servers', proxyRules: deadAddress, proxyBypassRules: '<-loopback>' });
	const beforeFailure = originHits;
	const failure = await requestAll(localUrl + '/must-not-fall-back');
	assert.ok(failure.every(result => !result.ok));
	assert.equal(originHits, beforeFailure, 'unreachable proxy must not fall back to direct access');
	passed('proxy connection failure does not silently fall back to reachable direct origin');
	report.pass = true;
} catch (error) {
	report.error = String(error?.message || error).slice(0, 1200);
	process.exitCode = 1;
} finally {
	if (electron) {
		await electron.evaluate(() => globalThis.networkTestIsolated?.window.destroy()).catch(() => { });
		await electron.close();
	}
	for (const socket of sockets) { socket.destroy(); }
	await Promise.all(servers.map(target => new Promise(resolve => target.close(resolve))));
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
	await rm(temp, { recursive: true, force: true });
}
