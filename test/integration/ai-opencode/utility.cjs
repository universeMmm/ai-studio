/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Validation host only. OpenCode stays outside the production dependency graph.
const { net } = require('electron');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const requests = [];
const unsupported = [];
// Chromium is the single HTTP transport, including Effect's FetchHttpClient and
// provider SDKs. It tracks app.setProxy({ mode: 'system' }) in the parent process.
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	if (!/^https?:$/.test(new URL(request.url).protocol)) {
		throw new Error('The validation host only allows HTTP(S) network requests.');
	}
	requests.push({ url: request.url, method: request.method });
	const authenticated = request.headers.has('authorization') || request.headers.has('x-api-key');
	return net.fetch(authenticated ? new Request(request, { redirect: 'error' }) : request);
};
// Unsupported transports must fail visibly instead of bypassing the desktop
// resolver. This trial does not enable arbitrary subprocess/plugin networking.
for (const name of ['node:http', 'node:https']) {
	const module = require(name);
	for (const method of ['get', 'request']) {
		module[method] = () => {
			unsupported.push(`${name}.${method}`);
			throw new Error('OpenCode attempted an unsupported Node transport; system proxy coverage is required.');
		};
	}
}
const socket = require('node:net').Socket.prototype;
const originalConnect = socket.connect;
socket.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first) || first && typeof first === 'object' && first.port !== undefined) {
		unsupported.push('node:net TCP');
		throw new Error('Direct Node TCP is disabled in the OpenCode validation host.');
	}
	return originalConnect.apply(this, args);
};
syncBuiltinESMExports();

process.parentPort.on('message', async ({ data }) => {
	try {
		let result;
		if (data.type === 'fetch') {
			const response = await fetch(data.url, { headers: data.headers, signal: AbortSignal.timeout(10000), cache: 'no-store' });
			result = { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 1000) };
		} else if (data.type === 'scenario') {
			const { runScenario } = await import(pathToFileURL(path.join(__dirname, 'sdk-scenario.mjs')).href);
			result = await runScenario({ ...data.options, report: progress => process.parentPort.postMessage({ id: data.id, progress }) });
		} else {
			throw new Error('Unknown validation request');
		}
		process.parentPort.postMessage({ id: data.id, result, requests, unsupported });
	} catch (error) {
		process.parentPort.postMessage({ id: data.id, error: error.stack || String(error), requests, unsupported });
	}
});
