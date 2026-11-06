/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Model Service
 *  Reads user configuration, selects the correct Provider, delegates all AI calls.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ExpectedError } from '../../../base/common/errors.js';
import { Barrier } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IAIKeychainService } from './credentialService.js';
import type { IAIProvider } from '../common/aiProvider.js';
import { AnthropicProvider } from '../common/anthropicProvider.js';
import { CustomProvider } from '../common/customProvider.js';
import { getAICredentialTarget, getUserAIConfiguration } from '../common/aiSecurityConfiguration.js';
import { getAIReasoningEfforts, normalizeAIReasoningEffort } from '../common/aiReasoning.js';
import type {
	AIProviderId,
	AIMessage,
	AITool,
	AIRequestOptions,
	AIStreamCallbacks,
	AICompletionOptions,
	AICompletionCallbacks,
	FileContext,
	AIModel,
} from '../common/aiTypes.js';

export const IAIModelService = createDecorator<IAIModelService>('aiModelService');

export interface IAIModelService {
	readonly _serviceBrand: undefined;
	readonly currentProviderId: AIProviderId;
	readonly currentModelId: string;
	readonly currentModelName: string;

	streamChat(messages: AIMessage[], tools: AITool[], options: AIRequestOptions, callbacks: AIStreamCallbacks): AbortController;
	streamCompletion(prefix: string, suffix: string, fileContext: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController;
	embed(texts: string[]): Promise<number[][]>;
	listModels(): Promise<AIModel[]>;
}

export class AIModelService extends Disposable implements IAIModelService {
	declare readonly _serviceBrand: undefined;

	private _provider: IAIProvider | null = null;
	private _initializing: Barrier | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IAIKeychainService private readonly keychainService: IAIKeychainService,
	) {
		super();
		this._register(this.keychainService.onDidChangeApiKey(() => { void this._initProvider(); }));
		void this._initProvider();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ai.apiType') ||
				e.affectsConfiguration('ai.apiKey') ||
				e.affectsConfiguration('ai.apiBase') ||
				e.affectsConfiguration('ai.modelId')) {
				void this._initProvider();
			}
		}));
	}

	// ── Public accessors ──────────────────────────────────────

	get currentProviderId(): AIProviderId {
		return getUserAIConfiguration<AIProviderId>(this.configurationService, 'ai.apiType', 'openai');
	}

	get currentModelId(): string {
		return this.configurationService.getValue<string>('ai.modelId') ?? '';
	}

	get currentModelName(): string {
		return this.configurationService.getValue<string>('ai.modelName')
			|| this.currentModelId
			|| 'AI';
	}

	// ── Provider delegation ──────────────────────────────────

	streamChat(messages: AIMessage[], tools: AITool[], options: AIRequestOptions, callbacks: AIStreamCallbacks): AbortController {
		return this._startStream(provider => {
			const allowed = getAIReasoningEfforts(this.currentProviderId, this.currentModelId, getUserAIConfiguration(this.configurationService, 'ai.apiBase', ''));
			const effort = normalizeAIReasoningEffort(options.reasoningEffort ?? getUserAIConfiguration(this.configurationService, 'ai.reasoningEffort', 'default'), allowed);
			return provider.streamChat(messages, tools, { ...options, reasoningEffort: effort }, callbacks);
		}, err => callbacks.onError(err));
	}

	streamCompletion(prefix: string, suffix: string, fileContext: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		return this._startStream(provider => provider.streamCompletion(prefix, suffix, fileContext, options, callbacks), err => callbacks.onError(err));
	}

	async embed(texts: string[]): Promise<number[][]> {
		return this._withProvider(provider => provider.embed(texts));
	}

	async listModels(): Promise<AIModel[]> {
		return this._withProvider(provider => provider.listModels());
	}

	// ── Internal ─────────────────────────────────────────────

	private async _initProvider(): Promise<void> {
		const previous = this._initializing;
		const initializing = this._initializing = new Barrier();
		previous?.open(); // Queued callers now wait for the current configuration.
		this._provider?.dispose();
		this._provider = null;
		try {
			const apiType = this.currentProviderId;
			const apiBase = getUserAIConfiguration(this.configurationService, 'ai.apiBase', '');
			const modelId = this.currentModelId;
			const apiKey = await this.keychainService.getApiKey(getAICredentialTarget(apiType, apiBase));
			if (this._initializing !== initializing) { return; }
			if (!apiKey || !modelId) {
				this.logService.warn('[AIModelService] Configure an API key and model ID to enable the provider.');
				return;
			}
			if (apiType === 'anthropic') {
				this._provider = new AnthropicProvider(apiKey, modelId, apiBase || undefined, this.logService);
			} else {
				const baseUrl = apiBase || 'https://api.openai.com/v1';
				this._provider = new CustomProvider(baseUrl, apiKey, modelId, this.logService);
			}
			this.logService.info(`[AIModelService] Provider ready: ${apiType}, model ${modelId}`);
		} catch (err) {
			if (this._initializing === initializing) {
				this.logService.error('[AIModelService] Failed to initialize provider:', err);
			}
		} finally {
			if (this._initializing === initializing) { this._initializing = undefined; }
			initializing.open();
		}
	}

	private async _withProvider<T>(action: (provider: IAIProvider) => T | Promise<T>): Promise<T> {
		while (this._initializing) {
			await this._initializing.wait();
		}
		if (!this._provider) {
			throw new ExpectedError(localize('studio.modelNotConfigured', '请打开「模型设置」，填写模型 ID 和 API 密钥后再发送消息。'));
		}
		return action(this._provider);
	}

	private _startStream(start: (provider: IAIProvider) => AbortController, onError: (err: Error) => void): AbortController {
		const controller = new AbortController();
		void this._withProvider(provider => {
			if (controller.signal.aborted) { return; }
			const request = start(provider);
			if (controller.signal.aborted) { request.abort(); }
			else { controller.signal.addEventListener('abort', () => request.abort(), { once: true }); }
		}).catch(err => {
			if (!controller.signal.aborted) { onError(err instanceof Error ? err : new Error(String(err))); }
		});
		return controller;
	}

	override dispose(): void {
		this._initializing?.open();
		this._initializing = undefined;
		this._provider?.dispose();
		this._provider = null;
		super.dispose();
	}
}
