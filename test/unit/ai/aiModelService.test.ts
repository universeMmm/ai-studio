/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 * AI Studio — provider initialization and reconfiguration.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../src/vs/base/common/event.js';
import { DeferredPromise } from '../../../src/vs/base/common/async.js';
import { TestConfigurationService } from '../../../src/vs/platform/configuration/test/common/testConfigurationService.js';
import type { IConfigurationChangeEvent } from '../../../src/vs/platform/configuration/common/configuration.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AIModelService } from '../../../src/vs/platform/ai/browser/aiModelService.js';
import type { IAIKeychainService } from '../../../src/vs/platform/ai/browser/credentialService.js';
import type { AICredentialTarget } from '../../../src/vs/platform/ai/common/aiSecurityConfiguration.js';

suite('AIModelService initialization', () => {
	let service: AIModelService;
	let config: TestConfigurationService;
	let keys: DeferredPromise<string>[];
	let keyTargets: AICredentialTarget[];
	let changedKey: Emitter<void>;
	let originalFetch: typeof globalThis.fetch;
	const options = { model: 'fixture', maxTokens: 50, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 1000 };

	setup(() => {
		originalFetch = globalThis.fetch;
		config = new TestConfigurationService({ 'ai.apiType': 'openai', 'ai.modelId': 'fixture', 'ai.apiBase': 'https://first.invalid' });
		keys = [];
		keyTargets = [];
		changedKey = new Emitter<void>();
		service = new AIModelService(config, new NullLogService(), {
			onDidChangeApiKey: changedKey.event,
			getApiKey(target: AICredentialTarget) {
				keyTargets.push(target);
				const result = new DeferredPromise<string>();
				keys.push(result);
				return result.p;
			},
		} as IAIKeychainService);
	});

	teardown(() => {
		service.dispose();
		changedKey.dispose();
		config.onDidChangeConfigurationEmitter.dispose();
		globalThis.fetch = originalFetch;
	});

	test('first embedding and model list wait for credentials', async () => {
		let requests = 0;
		globalThis.fetch = async () => { requests++; return Response.json({ data: [{ embedding: [1, 2] }] }); };
		const embedding = service.embed(['first']);
		const models = service.listModels();
		assert.strictEqual(requests, 0);
		await keys[0].complete('fixture');
		assert.deepStrictEqual(await embedding, [[1, 2]]);
		assert.ok((await models).length > 0);
		assert.strictEqual(requests, 1);
	});

	test('pending calls follow new configuration while an older credential read is still unresolved', async () => {
		const requests: [string, string | null][] = [];
		globalThis.fetch = async (url, opts) => {
			requests.push([String(url), new Headers(opts?.headers).get('Authorization')]);
			return Response.json({ data: [{ embedding: [1] }] });
		};
		const pending = service.embed(['waiting']);
		await config.setUserConfiguration('ai.apiBase', 'https://second.invalid');
		config.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: key => key === 'ai.apiBase' } as IConfigurationChangeEvent);
		await keys[1].complete('new-key');
		await pending;
		await keys[0].complete('old-key');
		await service.embed(['next']);
		assert.deepStrictEqual(requests, Array(2).fill(['https://second.invalid/embeddings', 'Bearer new-key']));
	});

	test('editing only the secure credential updates the active model', async () => {
		globalThis.fetch = async (_url, options) => {
			assert.strictEqual(new Headers(options?.headers).get('Authorization'), 'Bearer rotated');
			return Response.json({ data: [{ embedding: [1] }] });
		};
		await keys[0].complete('first');
		changedKey.fire();
		const next = service.embed(['after rotation']);
		await keys[1].complete('rotated');
		await next;
	});

	test('workspace endpoint and provider overrides cannot redirect an authenticated request', async () => {
		const user: Record<string, string> = { 'ai.apiType': 'openai', 'ai.apiBase': 'https://first.invalid' };
		const workspace: Record<string, string> = { 'ai.apiType': 'anthropic', 'ai.apiBase': 'https://repository.invalid' };
		config.inspect = <T>(key: string) => ({ userValue: user[key] as T, workspaceValue: workspace[key] as T, value: (workspace[key] ?? user[key]) as T });
		config.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: key => key === 'ai.apiBase' || key === 'ai.apiType' } as IConfigurationChangeEvent);
		const requests: string[] = [];
		globalThis.fetch = async (url, opts) => {
			requests.push(String(url));
			assert.strictEqual(new Headers(opts?.headers).get('Authorization'), 'Bearer trusted-key');
			return Response.json({ data: [{ embedding: [1] }] });
		};
		await keys[1].complete('trusted-key');
		await service.embed(['protected']);
		assert.deepStrictEqual(keyTargets, Array(2).fill({ provider: 'openai', origin: 'https://first.invalid' }));
		assert.deepStrictEqual(requests, ['https://first.invalid/embeddings']);
	});

	test('cancel before credentials skips a chat request; cancel after dispatch aborts the completion fetch', async () => {
		const dispatched = new DeferredPromise<AbortSignal>();
		let requests = 0;
		globalThis.fetch = (_url, opts) => {
			requests++;
			const signal = opts!.signal!;
			void dispatched.complete(signal);
			return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
		};
		const callbacks = { onToken() { }, onDone() { }, onError: assert.fail, onToolUse() { }, onToolResult() { } };
		service.streamChat([], [], options, callbacks).abort();
		const completion = service.streamCompletion('', '', {
			filePath: 'a.ts', languageId: 'typescript', content: '', cursorLine: 1, cursorColumn: 1,
		}, { maxTokens: 10, temperature: 0, stopSequences: [] }, callbacks);
		await keys[0].complete('fixture');
		const signal = await dispatched.p;
		assert.strictEqual(requests, 1);
		completion.abort();
		assert.strictEqual(signal.aborted, true);
	});
});
