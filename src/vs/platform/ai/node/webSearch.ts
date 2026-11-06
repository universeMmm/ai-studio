/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Desktop web search using the operating system's network proxy.
 *--------------------------------------------------------------------------------------------*/

import { escapeMarkdownSyntaxTokens } from '../../../base/common/htmlContent.js';
import { escape } from '../../../base/common/strings.js';
import { parseBingRss, parseDuckDuckGo, type SearchResult } from '../common/webSearchResults.js';

const MAX_RESPONSE_BYTES = 512 * 1024;
const PROVIDER_TIMEOUT_MS = 8000;

const providers = [
	{ name: 'DuckDuckGo', endpoint: 'https://lite.duckduckgo.com/lite/', parse: parseDuckDuckGo },
	{ name: 'Bing', endpoint: 'https://www.bing.com/search?format=rss', parse: parseBingRss },
];

async function readResultsPage(response: Response): Promise<string> {
	if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
	if (!response.body) { throw new Error('empty response'); }
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { return text + decoder.decode(); }
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) { throw new Error('response exceeds the size limit'); }
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

function formatResult(result: SearchResult): string {
	const title = escapeMarkdownSyntaxTokens(escape(result.title.slice(0, 300)));
	const url = result.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
	const snippet = result.snippet ? '\n  ' + escapeMarkdownSyntaxTokens(escape(result.snippet.slice(0, 350))) : '';
	return `- [${title}](${url})${snippet}`;
}

export async function searchWeb(
	input: { query: unknown; num_results?: unknown },
	request: (url: string, options: RequestInit) => Promise<Response>,
	signal: AbortSignal,
): Promise<string> {
	const query = typeof input.query === 'string' ? input.query.trim() : '';
	if (!query || query.length > 2048) { return 'Error searching: enter a query between 1 and 2048 characters.'; }
	const count = input.num_results;
	const limit = typeof count === 'number' && Number.isFinite(count) ? Math.max(1, Math.min(10, Math.trunc(count))) : 5;
	const failures: string[] = [];
	for (const provider of providers) {
		if (signal.aborted) { return 'Tool execution cancelled'; }
		const url = new URL(provider.endpoint);
		url.searchParams.set('q', query);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(abort, PROVIDER_TIMEOUT_MS);
		try {
			const response = await request(url.href, {
				credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
			});
			const page = await readResultsPage(response);
			if (signal.aborted) { return 'Tool execution cancelled'; }
			const results = provider.parse(page, limit);
			if (!results.length) { return 'No search results found for: ' + query; }
			return `## Web Search: ${query}\n\nSource: ${provider.name}\n\n${results.map(formatResult).join('\n')}`;
		} catch (error) {
			if (signal.aborted) { return 'Tool execution cancelled'; }
			const reason = controller.signal.aborted ? 'request timed out' : error instanceof Error ? error.message : String(error);
			failures.push(`${provider.name}: ${reason}`);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			controller.abort(); // Release any unread response, including an oversized or unsuccessful one.
		}
	}
	return 'Error searching: ' + failures.join('; ') + '. Check the network connection and the operating system proxy settings.';
}
