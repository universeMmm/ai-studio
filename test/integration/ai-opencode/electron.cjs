/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const { app, session, utilityProcess } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

let child;
const pending = new Map();
const servers = [];
const report = { sdk: '2.2.5', electron: process.versions.electron, checks: {}, productionEnabled: false };
const temp = path.join(os.tmpdir(), 'ai-studio-opencode-' + randomUUID());
app.setPath('userData', path.join(temp, 'electron'));
function invoke(type, extra = {}) {
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${type}`)); }, 90000);
		pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject });
		child.postMessage({ id, type, ...extra });
	});
}
function startUtility(env) {
	const worker = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], { env, stdio: 'pipe', serviceName: 'AI Studio OpenCode validation' });
	worker.stdout.on('data', data => process.stdout.write(data));
	worker.stderr.on('data', data => process.stderr.write(data));
	worker.on('message', data => {
		if (data.progress) { (report.progress ??= []).push(data.progress); return; }
		const wait = pending.get(data.id); if (wait) { pending.delete(data.id); wait.resolve(data); }
	});
	worker.on('exit', code => { for (const wait of pending.values()) { wait.reject(Error('Utility exited: ' + code)); } pending.clear(); });
	return worker;
}
async function listen(server) {
	servers.push(server);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}
function fixtureProxy(label, ledger) {
	return http.createServer(async (request, response) => {
		const url = new URL(request.url, 'http://fixture.invalid');
		ledger.push({ label, method: request.method, host: url.host, path: url.pathname });
		let body = '';
		for await (const chunk of request) { body += chunk; }
		if (url.pathname.endsWith('/chat/completions')) {
			const parsed = JSON.parse(body);
			report.offeredTools = (parsed.tools ?? []).map(tool => tool.function?.name);
			report.modelRequest = { model: parsed.model, messages: parsed.messages?.length, streaming: parsed.stream, syntheticKey: request.headers.authorization === 'Bearer ai-studio-fixture-only' };
			response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
			const base = { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model };
			const users = JSON.stringify(parsed.messages.filter(message => message.role === 'user'));
			const hasToolResult = parsed.messages.some(message => message.role === 'tool');
			const chunk = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
			if (users.includes('AI_STUDIO_CANCEL')) {
				chunk({ role: 'assistant', content: 'AI_STUDIO_WAITING' });
				response.on('close', () => { report.modelStreamCancelled = !response.writableEnded; });
				return;
			}
			if (!hasToolResult && (users.includes('AI_STUDIO_READ') || users.includes('AI_STUDIO_WEBFETCH_TOOL'))) {
				const web = users.includes('AI_STUDIO_WEBFETCH_TOOL');
				const name = web ? 'webfetch' : 'read';
				const args = web ? { url: 'http://page.fixture.invalid/page', format: 'text' } : { path: path.join(temp, 'workspace', 'read-check.txt') };
				assert.ok(parsed.tools.some(tool => tool.function?.name === name), 'SDK must offer the requested native tool');
				chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
				chunk({}, 'tool_calls');
				response.end('data: [DONE]\n\n');
				return;
			}
			response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'AI_STUDIO_OPENCODE_OK' }, finish_reason: null }] }) + '\n\n');
			response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) + '\n\n');
			response.end('data: [DONE]\n\n');
		} else if (url.pathname === '/auth-redirect') {
			response.writeHead(307, { Location: 'http://credential-target.fixture.invalid/leak' }); response.end();
		} else {
			response.writeHead(200, { 'Content-Type': 'text/plain' });
			response.end(url.hostname === 'page.fixture.invalid' ? 'SDK_WEBFETCH_OK' : label);
		}
	});
}

app.whenReady().then(async () => {
	try {
		await fs.mkdir(path.join(temp, 'workspace'), { recursive: true });
		const env = { ...process.env, OPENCODE_TEST_HOME: temp, OPENCODE_CONFIG_DIR: path.join(temp, 'config'), XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_STATE_HOME: path.join(temp, 'state'), XDG_CACHE_HOME: path.join(temp, 'cache'), AI_STUDIO_FIXTURE_KEY: 'fixture-key' };
		// Conflicting shell values must have no authority over Chromium's OS route.
		env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = 'http://127.0.0.1:1';
		env.NO_PROXY = '*';
		await app.setProxy({ mode: 'system' });
		child = startUtility(env);
		const reference = session.fromPartition('opencode-system-reference');
		await reference.setProxy({ mode: 'system' });
		const publicURL = 'https://example.com/';
		report.systemRoute = await app.resolveProxy(publicURL);
		assert.equal(report.systemRoute, await reference.resolveProxy(publicURL));
		const system = await invoke('fetch', { url: publicURL });
		assert.ok(!system.error && system.result.ok && system.result.text.includes('Example Domain'), system.error);
		report.checks.realSystemProxy = true;

		const ledger = [];
		const portA = await listen(fixtureProxy('proxy-a', ledger));
		const portB = await listen(fixtureProxy('proxy-b', ledger));
		await app.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${portA};https=127.0.0.1:${portA}`, proxyBypassRules: '<-loopback>' });
		let result = await invoke('fetch', { url: 'http://route.fixture.invalid/probe' });
		assert.equal(result.result?.text, 'proxy-a', result.error);
		await app.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${portB}`, proxyBypassRules: '<-loopback>' });
		result = await invoke('fetch', { url: 'http://route.fixture.invalid/probe' });
		assert.equal(result.result?.text, 'proxy-b', result.error);
		report.checks.proxySwitch = true;

		let directHits = 0;
		const directPort = await listen(http.createServer((_req, res) => { directHits++; res.end('direct'); }));
		const directURL = `http://127.0.0.1:${directPort}/probe`;
		const pac = `function FindProxyForURL(url, host) { if (host === '127.0.0.1') return 'DIRECT'; return 'PROXY 127.0.0.1:${portA}'; }`;
		const pacPort = await listen(http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig'); res.end(pac); }));
		await app.setProxy({ mode: 'pac_script', pacScript: `http://127.0.0.1:${pacPort}/proxy.pac`, pacMandatory: true });
		result = await invoke('fetch', { url: 'http://pac.fixture.invalid/probe' });
		assert.equal(result.result?.text, 'proxy-a', result.error);
		result = await invoke('fetch', { url: directURL });
		assert.equal(result.result?.text, 'direct', result.error);
		report.checks.pacAndBypass = true;

		await app.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:1', proxyBypassRules: '<-loopback>' });
		const before = directHits;
		result = await invoke('fetch', { url: directURL });
		assert.ok(result.error, 'A failed proxy must reject');
		assert.equal(directHits, before, 'A failed proxy must not fall back to DIRECT');
		report.checks.proxyFailureNoDirect = true;

		await app.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${portA}`, proxyBypassRules: '<-loopback>' });
		result = await invoke('fetch', { url: 'http://model.fixture.invalid/auth-redirect', headers: { 'x-api-key': 'synthetic-redirect-key' } });
		assert.ok(result.error, 'Authenticated requests must reject redirects');
		assert.ok(!ledger.some(entry => entry.host === 'credential-target.fixture.invalid'));
		report.checks.credentialsNotRedirected = true;
		const sdkRequestStart = result.requests.length;
		const options = { workspace: path.join(temp, 'workspace'), database: path.join(temp, 'sessions.db'), configDir: path.join(temp, 'config'), modelBaseURL: 'http://model.fixture.invalid/v1', exerciseTools: true, exerciseCancellation: true, exerciseRejectedPermission: true };
		const scenario = await invoke('scenario', { options });
		assert.ok(!scenario.error, scenario.error);
		assert.equal(scenario.unsupported.length, 0, JSON.stringify(scenario.unsupported));
		assert.ok(ledger.some(entry => entry.host === 'model.fixture.invalid' && entry.path === '/v1/chat/completions'));
		report.scenario = scenario.result;
		report.requests = scenario.requests;
		report.proxyRequests = ledger;
		const sdkRequests = scenario.requests.slice(sdkRequestStart);
		assert.ok(sdkRequests.every(request => {
			const url = new URL(request.url);
			return ledger.some(entry => entry.host === url.host && entry.path === url.pathname && entry.method === request.method);
		}), 'Every SDK HTTP request, including provider discovery and tools, must reach the proxy fixture');
		report.checks.allSdkHttpRequestsObservedAtProxy = true;
		report.checks.sdkUsesProxy = true;
		assert.ok(report.modelStreamCancelled, 'SDK cancellation must close the real HTTP stream');
		report.checks.sdkCancellationClosesStream = true;
		const old = child;
		await new Promise(resolve => { old.once('exit', resolve); old.kill(); });
		child = startUtility(env);
		const restored = await invoke('scenario', { options: { ...options, restoreSessionID: scenario.result.sessionID, expectedMessageIDs: scenario.result.messageIDs } });
		assert.ok(!restored.error, restored.error);
		assert.ok(!restored.requests.some(request => request.url.includes('/chat/completions')), 'Restore must not rerun a completed model turn');
		report.restart = restored.result;
		report.checks.crossProcessRestore = true;
		assert.equal(restored.unsupported.length, 0);
		report.pass = true;
	} catch (error) {
		report.error = error.stack || String(error);
		report.pass = false;
	} finally {
		child?.kill();
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		await fs.mkdir(path.dirname(process.env.AI_STUDIO_OPENCODE_REPORT), { recursive: true });
		await fs.writeFile(process.env.AI_STUDIO_OPENCODE_REPORT, JSON.stringify(report, null, 2) + '\n');
		console.log(JSON.stringify(report, null, 2));
		await fs.rm(temp, { recursive: true, force: true });
		app.exit(report.pass ? 0 : 1);
	}
});
