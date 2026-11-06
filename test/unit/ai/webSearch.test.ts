/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { useFakeTimers } from 'sinon';
import { searchWeb } from '../../../src/vs/platform/ai/node/webSearch.js';

const query = 'IANA & reserved #域名?format=html';
const primary = 'lite.duckduckgo.com';
const backup = 'www.bing.com';
const resultPage = '<a class="result-link" href="https://www.iana.org/domains/example">Example domains</a>';
const feed = '<rss version="2.0"><channel><title>Search</title><item><title>Example domains</title><link>https://www.iana.org/domains/example</link></item></channel></rss>';

suite('Desktop WebSearch', () => {
	type Request = Parameters<typeof searchWeb>[1];
	function captureRequest(respond: Request) {
		const calls: { url: URL; options: RequestInit }[] = [];
		const request: Request = async (url, options) => {
			calls.push({ url: new URL(url), options });
			return respond(url, options);
		};
		return { calls, request };
	}

	function assertRequests(calls: ReturnType<typeof captureRequest>['calls'], hosts: string[]) {
		assert.deepEqual(calls.map(call => call.url.hostname), hosts);
		for (const { url, options } of calls) {
			assert.equal(url.protocol, 'https:');
			assert.equal(url.searchParams.get('q'), query);
			assert.equal(url.hash, '');
			assert.equal(options.credentials, 'omit');
			assert.equal(new Headers(options.headers).has('cookie'), false);
			assert.equal(new Headers(options.headers).has('authorization'), false);
			assert.equal(options.redirect, 'error');
			if (url.hostname === backup) { assert.equal(url.searchParams.get('format'), 'rss'); }
		}
	}

	test('sends the encoded query only to the primary provider on success', async () => {
		const { calls, request } = captureRequest(async () => new Response(resultPage));
		const result = await searchWeb({ query }, request, new AbortController().signal);
		assert.match(result, /\[Example domains\]\(https:\/\/www\.iana\.org\/domains\/example\)/);
		assertRequests(calls, [primary]);
	});

	for (const [condition, response] of [
		['a bot challenge', () => new Response('<form id="challenge-form"></form>', { status: 202 })],
		['unexpected HTML', () => new Response('<html>Service offline</html>')],
		['HTTP rate limiting', () => new Response(null, { status: 429 })],
		['an oversized response', () => new Response(resultPage + 'x'.repeat(512 * 1024))],
	] as const) {
		test('falls back to the independent RSS provider after ' + condition, async () => {
			const { calls, request } = captureRequest(async url => new URL(url).hostname === primary ? response() : new Response(feed));
			const result = await searchWeb({ query }, request, new AbortController().signal);
			assert.match(result, /Source: Bing/);
			assert.match(result, /https:\/\/www\.iana\.org\/domains\/example/);
			assertRequests(calls, [primary, backup]);
		});
	}

	test('provider deadline aborts a pending request and still permits fallback', async () => {
		const clock = useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const { calls, request } = captureRequest(async (url, options) => {
				if (new URL(url).hostname === backup) { return new Response(feed); }
				return new Promise<Response>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
			});
			const pending = searchWeb({ query }, request, new AbortController().signal);
			await clock.runAllAsync();
			assert.match(await pending, /Source: Bing/);
			assert.equal(calls[0].options.signal!.aborted, true);
			assertRequests(calls, [primary, backup]);
		} finally {
			clock.restore();
		}
	});

	test('respects an explicit no-results response and avoids another search', async () => {
		const { calls, request } = captureRequest(async () => new Response('<div class="no-results">No results found</div>'));
		const result = await searchWeb({ query }, request, new AbortController().signal);
		assert.match(result, /no search results/i);
		assertRequests(calls, [primary]);
	});

	test('reports both provider failures without including private response bodies', async () => {
		const { calls, request } = captureRequest(async url => new Response('private response marker', { status: new URL(url).hostname === primary ? 429 : 503 }));
		const result = await searchWeb({ query }, request, new AbortController().signal);
		assert.match(result, /DuckDuckGo.*429/);
		assert.match(result, /Bing.*503/);
		assert.doesNotMatch(result, /private response marker/);
		assertRequests(calls, [primary, backup]);
	});

	test('user cancellation aborts the active request without sharing the query with the fallback', async () => {
		const controller = new AbortController();
		const { calls, request } = captureRequest(async (_url, options) =>
			new Promise<Response>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
		const pending = searchWeb({ query }, request, controller.signal);
		controller.abort();
		assert.equal(await pending, 'Tool execution cancelled');
		assertRequests(calls, [primary]);
		assert.equal(calls[0].options.signal!.aborted, true);

		const cancelled = captureRequest(async () => new Response(resultPage));
		assert.equal(await searchWeb({ query }, cancelled.request, controller.signal), 'Tool execution cancelled');
		assertRequests(cancelled.calls, []);
	});
});
