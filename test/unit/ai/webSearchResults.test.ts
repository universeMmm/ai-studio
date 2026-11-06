/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { parseDuckDuckGo, parseBingRss } from '../../../src/vs/platform/ai/common/webSearchResults.js';

suite('Web search result parsing', () => {
	const ddgRow = (href: string, title: string, snippet: string) =>
		`<tr><td valign="top">1.</td><td class="result-cell"><a rel="nofollow" href="${href}" class='result-link'>${title}</a></td></tr>
		<tr><td></td><td class='result-snippet'>${snippet}</td></tr>`;
	const rss = (items: string) => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Bing: query</title><link>https://www.bing.com/search?q=test</link>${items}</channel></rss>`;

	test('extracts only result rows, associates snippets, and decodes DuckDuckGo redirects once', () => {
		const target = 'https://example.org/resources?q=中文&x=1';
		const redirect = '//duckduckgo.com/l/?uddg=' + encodeURIComponent(target) + '&amp;rut=abc';
		const html = '<a href="https://nav.example/">Home</a>' +
			ddgRow(redirect, 'A &amp; B &#x2014; <b>资源</b>', '<b>Localized</b> &quot;summary&quot;.') +
			ddgRow(redirect, 'Duplicate', 'Wrong snippet') +
			ddgRow('https://second.example/', 'Second', 'Deuxième') +
			ddgRow('https://third.example/', 'Third', '');
		assert.deepEqual(parseDuckDuckGo(html, 2), [
			{ title: 'A & B — 资源', url: new URL(target).href, snippet: 'Localized "summary".' },
			{ title: 'Second', url: 'https://second.example/', snippet: 'Deuxième' },
		]);
	});

	test('rejects unsupported or credential-bearing destinations and ignores markup in comments', () => {
		const html = '<!--' + ddgRow('https://fake.example/', 'Fake', '') + '-->' +
			ddgRow('javascript:fake', 'Invalid', '') + ddgRow('/l/?uddg=file%3A%2F%2F%2Fetc', 'Unsafe redirect', '') +
			ddgRow('https://user:pw@example.org/', 'Credentials', '') + ddgRow('https://example.org/', 'Valid', '');
		assert.deepEqual(parseDuckDuckGo(html, 5), [{ title: 'Valid', url: 'https://example.org/' }]);
	});

	test('distinguishes an explicit DuckDuckGo no-results page from a challenge or format change', () => {
		assert.deepEqual(parseDuckDuckGo('<div class="no-results"><h1>No results found for xyz</h1></div>', 5), []);
		assert.throws(() => parseDuckDuckGo('<form id="challenge-form" action="https://duckduckgo.com/anomaly.js"></form>', 5), /challenge/);
		assert.throws(() => parseDuckDuckGo('<html><a href="https://news.example/">Homepage</a></html>', 5), /unrecognized/);
	});

	test('extracts Bing RSS items, XML entities and CDATA, excluding channel metadata and duplicates', () => {
		const item = '<item><title><![CDATA[Test & Verify]]></title><link>https://example.org/?a=1&amp;b=2</link><description>&lt;b&gt;Result&lt;/b&gt; summary</description></item>';
		const unsafe = '<item><title>Bad</title><link>data:text/html,x</link></item>';
		assert.deepEqual(parseBingRss(rss(unsafe + item + item), 5), [
			{ title: 'Test & Verify', url: 'https://example.org/?a=1&b=2', snippet: 'Result summary' },
		]);
	});

	test('keeps tag-like CDATA in the title from changing the result URL or item boundary', () => {
		const title = 'Example <link>https://wrong.example/</link> </item>';
		const item = `<item><title><![CDATA[${title}]]></title><link>https://correct.example/</link></item>`;
		assert.deepEqual(parseBingRss(rss(item), 1), [{ title, url: 'https://correct.example/' }]);
	});

	test('rejects repeated unterminated raw-text openers within the transport size limit', () => {
		for (const opener of ['<script>', '<style>', '<!--']) {
			assert.throws(() => parseDuckDuckGo(opener.repeat(50000), 1), /truncated HTML/);
		}
		for (const opener of ['<![CDATA[', '<!--']) {
			assert.throws(() => parseBingRss(rss(opener.repeat(50000)), 1), /truncated RSS/);
		}
	});

	test('recognizes an empty feed, rejects non-RSS, truncated RSS and unusable items', () => {
		assert.deepEqual(parseBingRss(rss(''), 5), []);
		assert.throws(() => parseBingRss('<html>captcha</html>', 5), /RSS/);
		assert.throws(() => parseBingRss(rss('').slice(0, -6), 5), /RSS/);
		assert.throws(() => parseBingRss(rss('<item><title>Missing URL</title></item>'), 5), /no usable/);
	});
});
