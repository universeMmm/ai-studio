/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { stub, useFakeTimers } from 'sinon';
import { fetchWebPage } from '../../../src/vs/platform/ai/electron-main/webFetch.js';

suite('Desktop WebFetch', () => {
	const url = 'https://example.invalid/pages/start';
	const html = '<p>欢迎</p>';
	let controller: AbortController;

	function mockTransport() {
		const calls: ClientRequestConstructorOptions[] = [];
		const client = Object.assign(new EventEmitter(), { end: stub(), abort: stub(), followRedirect: stub() });
		const request = (options: ClientRequestConstructorOptions): ClientRequest => {
			calls.push(options);
			return client as unknown as ClientRequest;
		};
		const respond = (statusCode = 200) => {
			const response = Object.assign(new EventEmitter(), { statusCode });
			client.emit('response', response);
			return response;
		};
		return { client, calls, request, respond };
	}

	setup(() => { controller = new AbortController(); });

	for (const protocol of ['http', 'https']) {
		test(`fetches ${protocol.toUpperCase()} content without session credentials`, async () => {
			const { client, calls, request, respond } = mockTransport();
			const target = `${protocol}://example.invalid/?term=%E5%9F%9F%E5%90%8D`;
			const pending = fetchWebPage(target, request, controller.signal);
			assert.equal(client.end.calledOnce, true);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, target);
			assert.equal(calls[0].credentials, 'omit');
			assert.equal(calls[0].redirect, 'manual');
			assert.ok(!Object.keys(calls[0].headers ?? {}).some(key => /^(authorization|cookie)$/i.test(key)));
			const response = respond();
			// Split inside a UTF-8 character, as a streaming transport can.
			const bytes = Buffer.from(html);
			response.emit('data', bytes.subarray(0, 4));
			response.emit('data', bytes.subarray(4));
			// Electron can close the request before delivering the buffered response end.
			client.emit('close');
			response.emit('end');
			assert.equal(await pending, html);
		});
	}

	test('rejects malformed, non-web and credential-bearing inputs before any request', async () => {
		const { request, calls } = mockTransport();
		for (const target of [undefined, 123, '', 'bad url', 'file:///tmp/test', 'data:text/plain,content', 'https://user:secret@example.invalid/']) {
			await assert.rejects(fetchWebPage(target, request, controller.signal));
		}
		assert.equal(calls.length, 0);
	});

	test('approves each HTTP(S) redirect before receiving the final response', async () => {
		const { client, request, respond } = mockTransport();
		const pending = fetchWebPage(url, request, controller.signal);
		// Chromium resolves Location against the previous hop before emitting redirect.
		client.emit('redirect', 302, 'GET', 'https://example.invalid/final?q=1', {});
		assert.equal(client.followRedirect.callCount, 1);
		client.emit('redirect', 301, 'GET', 'http://second.invalid/page', {});
		assert.equal(client.followRedirect.callCount, 2);
		const response = respond();
		response.emit('data', Buffer.from(html));
		response.emit('end');
		assert.equal(await pending, html);
	});

	test('aborts non-web and credential-bearing redirects without following them', async () => {
		for (const target of ['file:///tmp/private', 'data:text/html,unexpected', 'https://user:secret@example.invalid/next']) {
			const { client, request } = mockTransport();
			const pending = fetchWebPage(url, request, controller.signal);
			client.emit('redirect', 307, 'GET', target, {});
			await assert.rejects(pending);
			assert.equal(client.followRedirect.called, false);
			assert.equal(client.abort.calledOnce, true);
		}
	});

	test('reports HTTP 404 without returning the error page as content', async () => {
		const { client, request, respond } = mockTransport();
		const pending = fetchWebPage(url, request, controller.signal);
		const response = respond(404);
		response.emit('data', Buffer.from('private error page'));
		response.emit('end');
		await assert.rejects(pending, (err: Error) => {
			assert.match(err.message, /404/);
			assert.doesNotMatch(err.message, /private error page/);
			return true;
		});
		assert.equal(client.abort.calledOnce, true);
	});

	test('retains the first 500 KiB of a streamed response and stops downloading', async () => {
		const { client, request, respond } = mockTransport();
		const limit = 500 * 1024;
		const pending = fetchWebPage(url, request, controller.signal);
		const response = respond();
		response.emit('data', Buffer.alloc(limit - 2, 'a'));
		response.emit('data', Buffer.from('bcdef'));
		assert.equal(await pending, 'a'.repeat(limit - 2) + 'bc');
		assert.equal(client.abort.calledOnce, true);
	});

	test('enforces the request deadline even when the body stalls after headers arrive', async () => {
		const clock = useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const { client, request, respond } = mockTransport();
			const rejection = assert.rejects(fetchWebPage(url, request, controller.signal), /timed out/i);
			respond();
			await clock.tickAsync(15_000);
			await rejection;
			assert.equal(client.abort.calledOnce, true);
		} finally {
			clock.restore();
		}
	});

	test('forwards caller cancellation and skips requests started after cancellation', async () => {
		const { client, calls, request } = mockTransport();
		const pending = fetchWebPage(url, request, controller.signal);
		controller.abort();
		await assert.rejects(pending);
		assert.equal(client.abort.calledOnce, true);
		await assert.rejects(fetchWebPage(url, request, controller.signal));
		assert.equal(calls.length, 1);
	});

	test('reports an interrupted response instead of returning partial content', async () => {
		const { request, respond } = mockTransport();
		const pending = fetchWebPage(url, request, controller.signal);
		const response = respond();
		response.emit('data', Buffer.from('incomplete'));
		response.emit('aborted');
		await assert.rejects(pending);
	});
});
