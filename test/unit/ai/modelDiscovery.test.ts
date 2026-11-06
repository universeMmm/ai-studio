/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { fetch as transportFetch } from 'undici';
import { discoverModels } from '../../../src/vs/platform/ai/common/modelDiscovery.js';

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return 'http://127.0.0.1:' + address.port;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fixture(handler: RequestListener, run: (origin: string) => Promise<void>): Promise<void> {
	const server = createServer(handler);
	const origin = await listen(server);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((input, init) => {
		assert.equal(new URL(String(input)).origin, origin, 'only the fixture origin may be requested');
		assert.equal(init?.redirect, 'error');
		assert.equal(init?.credentials, 'omit');
		return transportFetch(input as string, init as Parameters<typeof transportFetch>[1]);
	}) as typeof fetch;
	try { await run(origin); }
	finally { globalThis.fetch = originalFetch; await close(server); }
}

suite('Model discovery', () => {
	test('real OpenAI GET uses the entered base/key, preserves query, deduplicates, and allows keyless local services', async () => {
		const requests: { path: string; auth?: string; method?: string }[] = [];
		await fixture((req, res) => {
			requests.push({ path: req.url!, auth: req.headers.authorization, method: req.method });
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ data: [{ id: ' first ' }, { id: 'first', name: 'Duplicate' }, { id: 'second', display_name: 'Second Model' }, { bad: 'row' }] }));
		}, async origin => {
			assert.deepEqual(await discoverModels({ endpoint: origin + '/custom/v1/?version=2', apiType: 'openai', apiKey: ' fixture-key ' }), [{ id: 'first' }, { id: 'second', name: 'Second Model' }]);
			await discoverModels({ endpoint: origin + '/custom/v1/models/', apiType: 'openai' });
			assert.deepEqual(requests, [
				{ path: '/custom/v1/models?version=2', auth: 'Bearer fixture-key', method: 'GET' },
				{ path: '/custom/v1/models', auth: undefined, method: 'GET' },
			]);
		});
	});

	test('Anthropic preserves namespace/v1, uses versioned auth, and follows only encoded same-origin cursors', async () => {
		const paths: string[] = [];
		await fixture((req, res) => {
			assert.equal(req.headers['x-api-key'], 'fixture-anthropic');
			assert.equal(req.headers['anthropic-version'], '2023-06-01');
			assert.equal(req.headers.authorization, undefined);
			const url = new URL(req.url!, 'http://fixture');
			assert.equal(url.pathname, '/anthropic/v1/models');
			assert.equal(url.searchParams.get('limit'), '1000');
			paths.push(req.url!);
			res.end(JSON.stringify(url.searchParams.has('after_id')
				? { data: [{ id: 'first' }, { id: 'second', display_name: 'Second' }], has_more: false }
				: { data: [{ id: 'first' }], has_more: true, last_id: 'cursor/?&=' }));
		}, async origin => {
			assert.deepEqual(await discoverModels({ endpoint: origin + '/anthropic/v1/', apiType: 'anthropic', apiKey: 'fixture-anthropic' }), [{ id: 'first' }, { id: 'second', name: 'Second' }]);
			assert.equal(paths.length, 2);
			assert.equal(new URL(paths[1], origin).searchParams.get('after_id'), 'cursor/?&=');
		});
	});

	test('empty endpoint agrees with credential defaults and Anthropic root appends v1 once', async () => {
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = (async input => { urls.push(String(input)); return new Response('{"data":[]}'); }) as typeof fetch;
		try {
			await discoverModels({ endpoint: ' ', apiType: 'openai' });
			await discoverModels({ endpoint: '', apiType: 'anthropic' });
			await discoverModels({ endpoint: 'https://fixture.invalid/anthropic', apiType: 'anthropic' });
			assert.deepEqual(urls, ['https://api.openai.com/v1/models', 'https://api.anthropic.com/v1/models?limit=1000', 'https://fixture.invalid/anthropic/v1/models?limit=1000']);
		} finally { globalThis.fetch = originalFetch; }
	});

	test('invalid destinations and pre-cancelled requests never call the transport', async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
		try {
			for (const endpoint of ['not a URL', 'file:///tmp/key', 'https://name:secret@fixture.invalid', 'https://fixture.invalid/#secret']) {
				await assert.rejects(discoverModels({ endpoint, apiType: 'openai', apiKey: 'secret' }), /HTTP\(S\)/);
			}
			await assert.rejects(discoverModels({ endpoint: 'https://fixture.invalid', apiType: 'unsupported' }), /HTTP\(S\)/);
			const ctl = new AbortController(); ctl.abort();
			await assert.rejects(discoverModels({ endpoint: 'https://fixture.invalid', apiType: 'openai', signal: ctl.signal }), { name: 'AbortError' });
			assert.equal(calls, 0);
		} finally { globalThis.fetch = originalFetch; }
	});

	test('empty, malformed, unauthorized and unsupported responses never invent models or expose response secrets', async () => {
		await fixture((req, res) => {
			const route = req.url!.split('/')[1];
			if (route === 'empty') { res.end('{"data":[]}'); return; }
			if (route === 'malformed') { res.end('<html>provider failure</html>'); return; }
			if (route === 'wrong') { res.end('{"models":["not-the-api-schema"]}'); return; }
			if (route === 'invalid') { res.end('{"data":[{"id":42},{"id":""}]}'); return; }
			res.statusCode = Number(route);
			res.end('provider echoed fixture-secret-token');
		}, async origin => {
			assert.deepEqual(await discoverModels({ endpoint: origin + '/empty', apiType: 'openai' }), []);
			for (const route of ['malformed', 'wrong', 'invalid']) { await assert.rejects(discoverModels({ endpoint: origin + '/' + route, apiType: 'openai' }), /格式无效/); }
			for (const status of [401, 403, 404, 405, 429, 500]) {
				await assert.rejects(discoverModels({ endpoint: origin + '/' + status, apiType: 'openai', apiKey: 'fixture-secret-token' }), error => error instanceof Error && error.message.includes(String(status)) && !error.message.includes('fixture-secret-token'));
			}
		});
	});

	test('both authentication schemes reject redirects before opening another origin', async () => {
		let destinationRequests = 0;
		const destination = createServer((req, res) => { destinationRequests++; req.resume(); res.end('{"data":[]}'); });
		const destinationUrl = await listen(destination);
		try {
			await fixture((req, res) => { req.resume(); res.writeHead(307, { location: destinationUrl + '/leak' }); res.end(); }, async origin => {
				for (const apiType of ['openai', 'anthropic']) { await assert.rejects(discoverModels({ endpoint: origin, apiType, apiKey: 'must-not-leak' }), /重定向/); }
				assert.equal(destinationRequests, 0);
			});
		} finally { await close(destination); }
	});

	test('timeout and external cancellation abort real pending network requests', async () => {
		await fixture((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('{"data":[');
			const timer = setTimeout(() => res.end(']}'), 3000);
			res.on('close', () => clearTimeout(timer));
		}, async origin => {
			await assert.rejects(discoverModels({ endpoint: origin, apiType: 'openai', timeoutMs: 35 }), /超时/);
			const ctl = new AbortController();
			const promise = discoverModels({ endpoint: origin, apiType: 'openai', signal: ctl.signal });
			const timer = setTimeout(() => ctl.abort(), 35);
			try { await assert.rejects(promise, { name: 'AbortError' }); }
			finally { clearTimeout(timer); }
		});
	});

	test('bounds declared and streamed response sizes, total pages, and model counts', async () => {
		await fixture((req, res) => {
			const url = new URL(req.url!, 'http://fixture');
			if (url.pathname.startsWith('/declared')) { res.setHeader('Content-Length', String(3 * 1024 * 1024)); res.end(); return; }
			if (url.pathname.startsWith('/streamed')) { res.write('{"data":[],"padding":"'); res.end('x'.repeat(2 * 1024 * 1024) + '"}'); return; }
			if (url.pathname.startsWith('/models-count')) { res.end(JSON.stringify({ data: Array.from({ length: 10_001 }, (_, i) => ({ id: 'model-' + i })) })); return; }
			const page = Number(url.searchParams.get('after_id') ?? 0);
			res.end(JSON.stringify({ data: [{ id: 'model-' + page }], has_more: true, last_id: String(page + 1) }));
		}, async origin => {
			for (const route of ['declared', 'streamed', 'models-count']) { await assert.rejects(discoverModels({ endpoint: origin + '/' + route, apiType: 'openai' }), /过大/); }
			await assert.rejects(discoverModels({ endpoint: origin + '/pages', apiType: 'anthropic' }), /过大/);
		});
	});

	test('rejects broken pagination instead of returning a misleading partial list', async () => {
		await fixture((req, res) => {
			const mode = req.url!.split('/')[1];
			res.end(JSON.stringify({ data: mode === 'empty' ? [] : [{ id: 'first' }], has_more: true, ...(mode === 'missing' ? {} : { last_id: 'same' }) }));
		}, async origin => {
			for (const mode of ['empty', 'missing', 'repeated']) { await assert.rejects(discoverModels({ endpoint: origin + '/' + mode, apiType: 'anthropic' }), /格式无效/); }
		});
	});
});
