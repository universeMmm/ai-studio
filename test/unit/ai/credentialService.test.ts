/*---------------------------------------------------------------------------------------------
 *  AI Studio - Credential Service Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { AIKeychainService } from "../../../src/vs/platform/ai/browser/credentialService.js";

suite("AIKeychainService", () => {

	function createService(secretStore: any, configStore: any) {
		const log: any = { info: () => {}, error: () => {}, warn: () => {} };
		return new AIKeychainService(secretStore, configStore, log);
	}

	test("getApiKey returns key from SecretStorage when available", async () => {
		const secretStore = { get: async () => 'sk-secret-123', set: async () => {}, delete: async () => {} };
		const configStore: any = { getValue: () => '', onDidChangeConfiguration: () => ({ dispose: () => {} }) };
		const svc = createService(secretStore, configStore);
		const key = await svc.getApiKey();
		assert.strictEqual(key, 'sk-secret-123');
	});

	test("getApiKey falls back to config when SecretStorage unavailable", async () => {
		const secretStore = { get: async () => { throw new Error('unavailable'); }, set: async () => {}, delete: async () => {} };
		const configStore: any = { getValue: (k: string) => k === 'ai.apiKey' ? 'sk-fallback' : '', onDidChangeConfiguration: () => ({ dispose: () => {} }) };
		const svc = createService(secretStore, configStore);
		const key = await svc.getApiKey();
		assert.strictEqual(key, 'sk-fallback');
	});

	test("getApiKey returns undefined when no key is configured", async () => {
		const secretStore = { get: async () => { throw new Error('unavailable'); }, set: async () => {}, delete: async () => {} };
		const configStore: any = { getValue: () => '', onDidChangeConfiguration: () => ({ dispose: () => {} }) };
		const svc = createService(secretStore, configStore);
		const key = await svc.getApiKey();
		assert.strictEqual(key, undefined);
	});

	test("setApiKey stores to SecretStorage", async () => {
		let stored = '';
		const secretStore = { get: async () => '', set: async (_k: string, v: string) => { stored = v; }, delete: async () => {} };
		const configStore: any = { getValue: () => '', onDidChangeConfiguration: () => ({ dispose: () => {} }), updateValue: async () => {} };
		const svc = createService(secretStore, configStore);
		await svc.setApiKey('sk-new-key');
		assert.strictEqual(stored, 'sk-new-key');
	});

	test("deleteApiKey is safe when no key exists", async () => {
		const secretStore = { get: async () => '', set: async () => {}, delete: async () => { throw new Error('not found'); } };
		const configStore: any = { getValue: () => '', onDidChangeConfiguration: () => ({ dispose: () => {} }) };
		const svc = createService(secretStore, configStore);
		await svc.deleteApiKey();
		// Should not throw
	});

});
