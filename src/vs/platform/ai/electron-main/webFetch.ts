/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Fetch a bounded preview of a web page using the desktop network stack.
 *--------------------------------------------------------------------------------------------*/

import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { promiseWithResolvers } from '../../../base/common/async.js';

const MAX_BYTES = 500 * 1024;
const TIMEOUT_MS = 15_000;

function webUrl(input: unknown): URL {
	const url = typeof input === 'string' && URL.canParse(input) ? new URL(input) : undefined;
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
		throw new Error('Expected an HTTP or HTTPS URL without embedded credentials');
	}
	return url;
}

export async function fetchWebPage(
	input: unknown,
	request: (options: ClientRequestConstructorOptions) => ClientRequest,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const req = request({ url: webUrl(input).href, redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: { 'User-Agent': 'AI-Studio/1.0' } });
	const { promise, resolve, reject } = promiseWithResolvers<string>();
	const cancel = () => reject(new Error('Tool execution cancelled'));
	signal.addEventListener('abort', cancel, { once: true });
	const timer = setTimeout(() => reject(new Error('Request timed out')), TIMEOUT_MS);
	try {
		// Electron requires approval inside the redirect event, before it connects to the next host.
		req.on('redirect', (_status, _method, url) => {
			try {
				webUrl(url);
				req.followRedirect();
			} catch (err) {
				reject(err);
			}
		});
		req.on('error', reject);
		req.once('response', response => {
			response.on('error', reject);
			response.once('aborted', () => reject(new Error('Response interrupted')));
			if (response.statusCode < 200 || response.statusCode >= 300) {
				reject(new Error(`HTTP ${response.statusCode}`));
				return;
			}

			const chunks: Buffer[] = [];
			let length = 0;
			const finish = () => resolve(Buffer.concat(chunks, length).toString('utf8'));
			response.once('end', finish);
			response.on('data', chunk => {
				if (length === MAX_BYTES) { return; }
				const part = chunk.subarray(0, MAX_BYTES - length);
				chunks.push(part);
				length += part.length;
				if (length === MAX_BYTES) { finish(); }
			});
		});
		req.end();
		return await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', cancel);
		req.abort();
	}
}
