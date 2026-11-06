/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Extract search results from the supported providers' public response formats.
 *--------------------------------------------------------------------------------------------*/

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

const entities: Readonly<Record<string, string>> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
	ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, name: string) => {
		if (!name.startsWith('#')) { return Object.hasOwn(entities, name) ? entities[name] : original; }
		const hex = name[1].toLowerCase() === 'x';
		const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
	});
}

function plainText(html: string): string {
	return decodeEntities(html.replace(/<[^<>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function resultUrl(value: string, fromDuckDuckGo = false): string | undefined {
	try {
		// Only DuckDuckGo's own wrappers may use relative paths.
		let url = new URL(value, fromDuckDuckGo ? 'https://lite.duckduckgo.com' : undefined);
		if (fromDuckDuckGo && /(?:^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname === '/l/') {
			url = new URL(url.searchParams.get('uddg') ?? '');
		} else if (fromDuckDuckGo && !/^(?:https?:)?\/\//i.test(value)) {
			return undefined;
		}
		if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
			return url.href;
		}
	} catch { /* Skip malformed provider links. */ }
	return undefined;
}

// Consume each raw-text block once. Searching for a closing tag again from every
// nested opener would let a bounded but malformed response stall the main process.
function normalizeRawSections(markup: string, format: 'html' | 'rss'): string {
	const open = format === 'html' ? /<!--|<(script|style)\b[^<>]*>/gi : /<!--|<!\[CDATA\[/g;
	const parts: string[] = [];
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = open.exec(markup))) {
		parts.push(markup.slice(cursor, match.index));
		const start = open.lastIndex;
		if (match[1]) {
			const close = match[1].toLowerCase() === 'script' ? /<\/script\s*>/gi : /<\/style\s*>/gi;
			close.lastIndex = start;
			if (!close.test(markup)) { throw new Error('DuckDuckGo returned truncated HTML'); }
			cursor = close.lastIndex;
		} else {
			const cdata = match[0] === '<![CDATA[';
			const end = markup.indexOf(cdata ? ']]>' : '-->', start);
			if (end < 0) { throw new Error(format === 'rss' ? 'Bing returned truncated RSS' : 'DuckDuckGo returned truncated HTML'); }
			if (cdata) {
				// Preserve literal tag-like text without treating it as a link or item boundary.
				parts.push(markup.slice(start, end).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
			}
			cursor = end + 3;
		}
		open.lastIndex = cursor;
	}
	parts.push(markup.slice(cursor));
	return parts.join('');
}

export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
	html = normalizeRawSections(html, 'html');
	if (/<form\b[^<>]*(?:anomaly\.js|challenge-form)/i.test(html)) {
		throw new Error('DuckDuckGo returned a bot challenge');
	}

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	let current: SearchResult | undefined;
	// Lite uses separate table rows for the result link, summary and displayed hostname.
	let field: { tag: string; start: number; href?: string } | undefined;
	for (const match of html.matchAll(/<(\/?)(a|td)\b([^<>]*)>/gi)) {
		const tag = match[2].toLowerCase();
		const attrs = match[3];
		if (!match[1]) {
			const classes = /\sclass\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2].split(/\s+/);
			if (tag === 'a' && classes?.includes('result-link')) {
				current = undefined;
				if (results.length >= limit) { break; }
				field = { tag, start: match.index + match[0].length, href: /\shref\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] };
			} else if (tag === 'td' && classes?.includes('result-snippet')) {
				field = { tag, start: match.index + match[0].length };
			}
		} else if (field?.tag === tag) {
			const text = plainText(html.slice(field.start, match.index));
			if (tag === 'a') {
				const url = field.href && resultUrl(decodeEntities(field.href), true);
				if (url && text && !seen.has(url)) {
					seen.add(url);
					current = { title: text, url };
					results.push(current);
				}
			} else if (current && text) {
				current.snippet = text;
			}
			field = undefined;
		}
	}
	if (results.length || /\bclass\s*=\s*["'][^"']*\bno-results\b[^"']*["']|<(?:h1|td)\b[^<>]*>\s*No (?:more )?results (?:found for|were found)\b/i.test(html)) {
		return results;
	}
	throw new Error('DuckDuckGo returned an unrecognized results page');
}

function rssText(item: string, tag: 'link' | 'title' | 'description'): string {
	const open = new RegExp(`<${tag}\\b[^<>]*>`, 'i').exec(item);
	if (!open) { return ''; }
	const start = open.index + open[0].length;
	const end = item.indexOf(`</${tag}>`, start);
	return end < 0 ? '' : decodeEntities(item.slice(start, end).trim());
}

export function parseBingRss(xml: string, limit: number): SearchResult[] {
	xml = normalizeRawSections(xml, 'rss');
	const channel = /^\s*(?:<\?xml\b[^?]*\?>\s*)?<rss\b[^<>]*>\s*<channel\b[^<>]*>([\s\S]*?)<\/channel>\s*<\/rss>\s*$/i.exec(xml)?.[1];
	if (!channel || !/<title\b/i.test(channel)) { throw new Error('Bing returned an invalid RSS feed'); }

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const record of channel.split(/<item\b[^<>]*>/i).slice(1)) {
		const end = record.indexOf('</item>');
		if (end < 0) { throw new Error('Bing returned a truncated RSS item'); }
		const item = record.slice(0, end);
		const url = resultUrl(rssText(item, 'link'));
		const title = rssText(item, 'title').replace(/\s+/g, ' ').trim();
		if (url && title && !seen.has(url)) {
			seen.add(url);
			const snippet = plainText(rssText(item, 'description'));
			results.push(snippet ? { title, url, snippet } : { title, url });
			if (results.length >= limit) { break; }
		}
	}
	if (!results.length && /<item\b/i.test(channel)) { throw new Error('Bing returned no usable result links'); }
	return results;
}
