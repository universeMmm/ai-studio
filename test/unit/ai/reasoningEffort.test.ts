/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../src/vs/base/common/event.js';
import { TestConfigurationService } from '../../../src/vs/platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { AIModelService } from '../../../src/vs/platform/ai/browser/aiModelService.js';
import type { IAIKeychainService } from '../../../src/vs/platform/ai/browser/credentialService.js';
import { AnthropicProvider } from '../../../src/vs/platform/ai/common/anthropicProvider.js';
import { getAIReasoningEfforts } from '../../../src/vs/platform/ai/common/aiReasoning.js';
import type { AIRequestOptions, AIStreamCallbacks } from '../../../src/vs/platform/ai/common/aiTypes.js';

const options: AIRequestOptions = { model: '', maxTokens: 4000, temperature: 0, thinking: false, cacheSystemPrompt: false, maxContextTokens: 16000 };
function collect(run: (callbacks: AIStreamCallbacks) => void): Promise<void> {
	return new Promise((resolve, reject) => run({ onDone: () => resolve(), onError: reject, onToken() { }, onToolUse() { }, onToolResult() { } }));
}

suite('User reasoning selection', () => {
	let original: typeof fetch;
	setup(() => { original = globalThis.fetch; });
	teardown(() => { globalThis.fetch = original; });

	test('unsupported and Responses-only models do not inherit a misleading effort menu', () => {
		for (const model of ['gpt-4o', 'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-6-astra', 'unknown']) {
			assert.deepStrictEqual(getAIReasoningEfforts('openai', model), ['default']);
		}
		assert.deepStrictEqual(getAIReasoningEfforts('anthropic', 'claude-sonnet-4-5'), ['default']);
		assert.deepStrictEqual(getAIReasoningEfforts('openai', 'deepseek-flash', 'https://gateway.invalid'), ['default', 'low', 'high']);
	});

	test('shared model service sends changed user effort on the next real provider request', async () => {
		const config = new TestConfigurationService({ 'ai.apiType': 'openai', 'ai.modelId': 'gpt-5.2', 'ai.apiBase': 'https://gateway.invalid', 'ai.reasoningEffort': 'low' });
		const change = new Emitter<void>();
		const service = new AIModelService(config, new NullLogService(), { onDidChangeApiKey: change.event, async getApiKey() { return 'fixture'; } } as IAIKeychainService);
		const bodies: Record<string, unknown>[] = [];
		globalThis.fetch = async (url, init) => {
			assert.strictEqual(String(url), 'https://gateway.invalid/chat/completions');
			assert.strictEqual(init?.redirect, 'error');
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		};
		try {
			await collect(cb => service.streamChat([], [], options, cb));
			await config.setUserConfiguration('ai.reasoningEffort', 'high');
			await collect(cb => service.streamChat([], [], options, cb));
			await config.setUserConfiguration('ai.reasoningEffort', 'invalid');
			await collect(cb => service.streamChat([], [], options, cb));
			assert.deepStrictEqual(bodies.map(body => body.reasoning_effort), ['low', 'high', undefined]);
			for (const body of bodies) {
				assert.strictEqual(body.max_completion_tokens, 4000);
				assert.ok(!Object.hasOwn(body, 'max_tokens'));
				assert.ok(!Object.hasOwn(body, 'temperature'));
			}
		} finally { service.dispose(); change.dispose(); config.onDidChangeConfigurationEmitter.dispose(); }
	});

	test('Claude effort uses output_config without enabling unsupported thinking round trips', async () => {
		const bodies: Record<string, unknown>[] = [];
		globalThis.fetch = async (_url, init) => {
			assert.strictEqual(init?.redirect, 'error');
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
		};
		for (const model of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-7']) {
			const provider = new AnthropicProvider('fixture', model, 'https://gateway.invalid', new NullLogService());
			try { await collect(cb => provider.streamChat([], [], { ...options, reasoningEffort: 'high' }, cb)); }
			finally { provider.dispose(); }
		}
		assert.deepStrictEqual(bodies[0].output_config, { effort: 'high' });
		assert.deepStrictEqual(bodies[0].thinking, { type: 'disabled' });
		assert.ok(!Object.hasOwn(bodies[1], 'output_config'));
		assert.deepStrictEqual(bodies[2].output_config, { effort: 'high' });
		assert.ok(!Object.hasOwn(bodies[2], 'temperature'));
	});
});
