/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AIKeychainService } from '../../../src/vs/platform/ai/browser/credentialService.js';
import { getAICredentialTarget, getUserAIConfiguration } from '../../../src/vs/platform/ai/common/aiSecurityConfiguration.js';
import { aiConfigurationNode } from '../../../src/vs/platform/ai/common/aiConfiguration.js';
import { ConfigurationScope } from '../../../src/vs/platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, type IConfigurationValue } from '../../../src/vs/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../src/vs/platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { Emitter } from '../../../src/vs/base/common/event.js';

class ScopedConfiguration extends TestConfigurationService {
	readonly workspace: Record<string, unknown> = {};
	readonly updates: [string, unknown, ConfigurationTarget | undefined][] = [];
	override inspect<T>(key: string): IConfigurationValue<T> {
		const user = super.inspect<T>(key);
		return { ...user, workspaceValue: this.workspace[key] as T, value: (this.workspace[key] as T) ?? user.value };
	}
	override async updateValue(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
		this.updates.push([key, value, target]);
		await this.setUserConfiguration(key, value);
	}
}

suite('AI credentials and configuration trust', () => {
	const first = getAICredentialTarget('openai', 'https://first.invalid/v1');
	const second = getAICredentialTarget('openai', 'https://second.invalid/v1');
	let config: ScopedConfiguration;
	let secrets: Map<string, string>;
	let service: AIKeychainService;
	let failWrite: boolean;
	let storageType: 'persisted' | 'in-memory';
	let changed: Emitter<string>;
	function start(configuration = config) {
		const created = new AIKeychainService({
			_serviceBrand: undefined, get type() { return storageType; }, onDidChangeSecret: changed.event,
			get: async key => secrets.get(key),
			set: async (key, value) => { if (failWrite) { throw new Error('store unavailable'); } secrets.set(key, value); },
			delete: async key => { secrets.delete(key); },
		}, configuration, new NullLogService());
		if (configuration === config) { service = created; }
		return created;
	}
	setup(() => {
		config = new ScopedConfiguration({ 'ai.apiType': 'openai', 'ai.apiBase': first.origin });
		secrets = new Map(); failWrite = false; storageType = 'persisted'; changed = new Emitter();
	});
	teardown(() => { service?.dispose(); changed.dispose(); config.onDidChangeConfigurationEmitter.dispose(); });

	test('sensitive configuration is user-only, even in a trusted workspace', () => {
		for (const key of ['ai.apiType', 'ai.apiBase', 'ai.apiKey', 'ai.commandApproval', 'ai.commandSandbox']) {
			assert.strictEqual(aiConfigurationNode.properties![key].scope, ConfigurationScope.MACHINE);
			assert.strictEqual(aiConfigurationNode.properties![key].restricted, true);
		}
		config.workspace['ai.commandApproval'] = 'none';
		assert.strictEqual(getUserAIConfiguration(config, 'ai.commandApproval', 'unsafe'), 'unsafe');
	});

	test('binds an explicit user credential to its original destination despite a settings change during migration', async () => {
		await config.setUserConfiguration('ai.apiKey', 'legacy');
		config.workspace['ai.apiBase'] = 'https://untrusted.invalid';
		start();
		await config.setUserConfiguration('ai.apiBase', second.origin);
		assert.strictEqual(await service.getApiKey(second), undefined);
		assert.strictEqual(await service.getApiKey(first), 'legacy');
		assert.strictEqual(secrets.has('ai-studio.apiKey'), false);
	});

	test('migrates a user plaintext key to secure storage and removes its user setting', async () => {
		await config.setUserConfiguration('ai.apiKey', 'legacy-setting');
		config.workspace['ai.apiKey'] = 'repository-secret';
		start();
		assert.strictEqual(await service.getApiKey(first), 'legacy-setting');
		assert.deepStrictEqual(config.updates, [['ai.apiKey', undefined, ConfigurationTarget.USER_LOCAL]]);
		assert.strictEqual(await service.getApiKey(second), undefined);
	});

	test('does not guess the destination of an old key whose endpoint came only from the workspace', async () => {
		await config.setUserConfiguration('ai.apiBase', undefined);
		config.workspace['ai.apiBase'] = 'https://repository.invalid';
		secrets.set('ai-studio.apiKey', 'legacy');
		start();
		assert.strictEqual(await service.getApiKey(), undefined);
		assert.strictEqual(secrets.get('ai-studio.apiKey'), 'legacy');
	});

	test('keys remain separated by origin and protocol provider, and same-origin API paths reuse the binding', async () => {
		start();
		await service.setApiKey('first-key', first);
		await service.setApiKey('second-key', second);
		assert.strictEqual(await service.getApiKey(getAICredentialTarget('openai', 'https://FIRST.invalid:443/v2')), 'first-key');
		assert.strictEqual(await service.getApiKey(getAICredentialTarget('anthropic', first.origin)), undefined);
		assert.strictEqual(await service.getApiKey(getAICredentialTarget('openai', 'http://first.invalid')), undefined);
		assert.strictEqual(await service.getApiKey(second), 'second-key');
		await service.deleteApiKey(first);
		assert.strictEqual(await service.getApiKey(first), undefined);
		assert.strictEqual(await service.getApiKey(second), 'second-key');
	});

	test('two windows never copy an unbound global secret to their different destinations', async () => {
		secrets.set('ai-studio.apiKey', 'unbound-legacy');
		const otherConfig = new ScopedConfiguration({ 'ai.apiType': 'openai', 'ai.apiBase': second.origin });
		start();
		const otherService = start(otherConfig);
		try {
			assert.deepStrictEqual(await Promise.all([service.getApiKey(first), otherService.getApiKey(second)]), [undefined, undefined]);
			assert.strictEqual(secrets.get('ai-studio.apiKey'), 'unbound-legacy');
			await service.setApiKey('explicitly-saved', first);
			assert.strictEqual(await service.getApiKey(first), 'explicitly-saved');
			assert.strictEqual(await otherService.getApiKey(second), undefined);
		} finally { otherService.dispose(); otherConfig.onDidChangeConfigurationEmitter.dispose(); }
	});

	test('secure-store failure neither falls back to plaintext nor changes settings', async () => {
		start();
		assert.strictEqual(await service.getApiKey(first), undefined);
		failWrite = true;
		await assert.rejects(service.setApiKey('never-plaintext', first), /unavailable/);
		assert.deepStrictEqual(config.updates, []);
		assert.strictEqual(await service.getApiKey(first), undefined);
	});

	test('rejects embedded URL credentials and non-HTTP endpoints', () => {
		assert.throws(() => getAICredentialTarget('openai', 'https://user:pass@first.invalid'), /without embedded/);
		assert.throws(() => getAICredentialTarget('openai', 'file:///tmp/model'), /HTTP/);
	});

	test('legacy key entry is hidden and cannot opt into settings sync', () => {
		const legacy = aiConfigurationNode.properties!['ai.apiKey'];
		assert.equal(legacy.included, false);
		assert.equal(legacy.ignoreSync, true);
	});

	test('ephemeral storage never removes the only persisted legacy key', async () => {
		storageType = 'in-memory';
		await config.setUserConfiguration('ai.apiKey', 'recoverable'); start();
		assert.equal(await service.getApiKey(first), undefined);
		assert.equal(config.inspect('ai.apiKey').userLocalValue, 'recoverable');
		assert.deepEqual(config.updates, []);
	});

	test('failed secure migration preserves plaintext without using it for requests', async () => {
		failWrite = true;
		await config.setUserConfiguration('ai.apiKey', 'recoverable'); start();
		assert.equal(await service.getApiKey(first), undefined);
		assert.equal(config.inspect('ai.apiKey').userLocalValue, 'recoverable');
	});

	test('replacing a plaintext model key requires verified persistent storage', async () => {
		start(); storageType = 'in-memory';
		await assert.rejects(service.setApiKey('replacement', first, { requirePersisted: true }), /Persistent secret storage/);
		assert.equal(secrets.size, 0);
		storageType = 'persisted';
		await service.setApiKey('replacement', first, { requirePersisted: true });
		assert.equal(await service.getApiKey(first), 'replacement');
	});

	test('migration does not overwrite an existing key or discard a conflicting legacy value', async () => {
		secrets.set('ai-studio.apiKey.v2:openai:' + encodeURIComponent(first.origin), 'current');
		await config.setUserConfiguration('ai.apiKey', 'recoverable'); start();
		assert.equal(await service.getApiKey(first), 'current');
		assert.equal(config.inspect('ai.apiKey').userLocalValue, 'recoverable');
	});

	test('changes from another window invalidate consumers and empty saves are rejected', async () => {
		start(); let events = 0;
		const listener = service.onDidChangeApiKey(() => events++);
		try {
			changed.fire('unrelated'); assert.equal(events, 0);
			changed.fire('ai-studio.apiKey.v2:openai:' + encodeURIComponent(first.origin)); assert.equal(events, 1);
			await assert.rejects(service.setApiKey('   ', first), /empty/);
			assert.equal(secrets.size, 0);
		} finally { listener.dispose(); }
	});
});
