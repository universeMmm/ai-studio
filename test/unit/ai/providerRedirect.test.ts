/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { fetch as transportFetch } from 'undici';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AnthropicProvider } from '../../../src/vs/platform/ai/common/anthropicProvider.js';
import { CustomProvider } from '../../../src/vs/platform/ai/common/customProvider.js';
import type { IAIProvider } from '../../../src/vs/platform/ai/common/aiProvider.js';
import { collectAgentTurn } from '../../../src/vs/platform/ai/common/toolRuntime.js';

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return 'http://127.0.0.1:' + address.port;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

suite('Provider credential redirects', () => {
	test('authenticated chat, completion and embedding requests never reach a redirected origin', async () => {
		const key = 'redirect-test-key-not-a-real-credential';
		const originalFetch = globalThis.fetch;
		let destinationRequests = 0;
		const received: { url: string; authorization?: string; apiKey?: string | string[] }[] = [];
		const destination = createServer((request, response) => {
			destinationRequests++;
			request.resume();
			response.end('This origin must not receive a request.');
		});
		const destinationUrl = await listen(destination);
		const source = createServer((request, response) => {
			received.push({ url: request.url!, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] });
			request.resume();
			response.writeHead(307, { location: destinationUrl + '/capture' });
			response.end();
		});
		const sourceUrl = await listen(source);
		const log = new NullLogService();
		const providers = [new CustomProvider(sourceUrl, key, 'fixture', log), new AnthropicProvider(key, 'fixture', sourceUrl, log)];
		// Only this loopback fixture can use the real transport. Other AI tests remain network-disabled.
		globalThis.fetch = ((url, init) => {
			assert.equal(new URL(String(url)).origin, sourceUrl);
			return transportFetch(url as string, init as Parameters<typeof transportFetch>[1]);
		}) as typeof fetch;
		const completion = (provider: IAIProvider) => new Promise<string>((resolve, reject) => {
			provider.streamCompletion('', '', { filePath: '/fixture.ts', languageId: 'typescript', content: '', cursorLine: 1, cursorColumn: 1 },
				{ maxTokens: 100, temperature: 0, stopSequences: [] }, { onToken() { }, onDone: resolve, onError: reject });
		});
		try {
			for (const provider of providers) {
				await assert.rejects(collectAgentTurn(provider, [{ role: 'user', content: 'fixture' }], [], {
					model: 'fixture', maxTokens: 100, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 1000,
				}, new AbortController().signal), /fetch failed/);
				await assert.rejects(completion(provider), /fetch failed/);
			}
			await assert.rejects(providers[0].embed(['fixture']), /fetch failed/);
			assert.equal(received.length, 5);
			assert.equal(received.filter(request => request.authorization === 'Bearer ' + key).length, 3);
			assert.equal(received.filter(request => request.apiKey === key).length, 2);
			assert.equal(destinationRequests, 0, 'redirect must fail before opening a request to the second origin');
		} finally {
			globalThis.fetch = originalFetch;
			providers.forEach(provider => provider.dispose());
			await Promise.all([close(source), close(destination)]);
		}
	});
});
