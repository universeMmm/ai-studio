/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHttpPatch, LogLevel, type ProxyAgentParams } from '@vscode/proxy-agent';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createExtensionProxyResolver } from '../../node/proxyResolver.js';

suite('Desktop extension host system proxy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function params(resolveProxy: ProxyAgentParams['resolveProxy']): ProxyAgentParams {
		return {
			resolveProxy,
			getProxyURL: () => 'http://stale.invalid',
			env: { HTTPS_PROXY: 'http://stale.invalid' },
			isUseHostProxyEnabled: () => true,
			getProxySupport: () => 'override',
			isAdditionalFetchSupportEnabled: () => true,
			isWebSocketPatchEnabled: () => true,
			addCertificatesV1: () => false,
			addCertificatesV2: () => false,
			loadSystemCertificatesFromNode: () => false,
			loadAdditionalCertificates: async () => [],
			getLogLevel: () => LogLevel.Off,
			log: new NullLogService(),
			proxyResolveTelemetry: () => { },
		};
	}

	test('resolves each full URL with the host, including when the system route changes', async () => {
		let route = 'PROXY proxy.test:8080';
		const resolver = createExtensionProxyResolver(params(async url => url.endsWith('/local') ? 'DIRECT' : route), () => true);
		assert.strictEqual(await resolver.resolveProxyURL('http://example.test/a'), 'http://proxy.test:8080');
		assert.strictEqual(await resolver.resolveProxyURL('http://example.test/local'), undefined);
		route = 'SOCKS5 socks.test:1080';
		assert.strictEqual(await resolver.resolveProxyURL('http://example.test/a'), 'socks://socks.test:1080');
	});

	test('a remote host can switch between its own network and the desktop system network', async () => {
		let inheritDesktop = false;
		const resolver = createExtensionProxyResolver(params(async () => 'PROXY desktop.test:8080'), () => inheritDesktop);
		const url = 'https://example.test/';
		assert.strictEqual(await resolver.resolveProxyURL(url), 'http://stale.invalid');
		inheritDesktop = true;
		assert.strictEqual(await resolver.resolveProxyURL(url), 'http://desktop.test:8080');
		inheritDesktop = false;
		assert.strictEqual(await resolver.resolveProxyURL(url), 'http://stale.invalid');
	});

	test('Node HTTP emits an error when system proxy resolution fails', async () => {
		const http = await import('http');
		const lookupFailure = new Error('System proxy resolution failed');
		const options = params(async () => { throw lookupFailure; });
		const resolver = createExtensionProxyResolver(options, () => true);
		const patchedHttp = createHttpPatch(options, http, resolver.resolveProxyWithRequest);
		await assert.rejects(new Promise((resolve, reject) => {
			patchedHttp.get('http://unreachable.invalid/a', {}, resolve).on('error', reject);
		}), error => error === lookupFailure);
	});
});
