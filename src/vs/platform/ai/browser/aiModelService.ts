/*---------------------------------------------------------------------------------------------
 *  AI Studio — Model Service
 *  Reads user configuration, selects the correct Provider, delegates all AI calls.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IAIKeychainService } from './credentialService.js';
import type { IAIProvider } from '../common/aiProvider.js';
import { AnthropicProvider } from '../common/anthropicProvider.js';
import { CustomProvider } from '../common/customProvider.js';
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

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IAIKeychainService private readonly keychainService: IAIKeychainService,
	) {
		super();
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
		return this.configurationService.getValue<AIProviderId>('ai.apiType') ?? 'openai';
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
		return this._ensureProvider().streamChat(messages, tools, options, callbacks);
	}

	streamCompletion(prefix: string, suffix: string, fileContext: FileContext, options: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		return this._ensureProvider().streamCompletion(prefix, suffix, fileContext, options, callbacks);
	}

	async embed(texts: string[]): Promise<number[][]> {
		return this._ensureProvider().embed(texts);
	}

	async listModels(): Promise<AIModel[]> {
		return this._ensureProvider().listModels();
	}

	// ── Internal ─────────────────────────────────────────────

	private async _initProvider(): Promise<void> {
		if (this._provider) {
			this._provider.dispose();
		}
		this._provider = null;

		const apiType = this.configurationService.getValue<string>('ai.apiType') ?? 'openai';
		const apiKey = await this.keychainService.getApiKey() ?? '';
		const apiBase = this.configurationService.getValue<string>('ai.apiBase') ?? '';
		const modelId = this.configurationService.getValue<string>('ai.modelId') ?? 'claude-sonnet-4-6';

		if (!apiKey) {
			this.logService.warn('[AIModelService] No AI API key configured — store one with AI Studio credentials or set ai.apiKey as a fallback.');
			return;
		}

		try {
			if (apiType === 'anthropic') {
				this._provider = new AnthropicProvider(apiKey, modelId, apiBase || undefined, this.logService);
			} else {
				const baseUrl = apiBase || 'https://api.openai.com/v1';
				this._provider = new CustomProvider(baseUrl, apiKey, modelId, this.logService);
			}
			this.logService.info(`[AIModelService] Provider ready: ${apiType}, model ${modelId}`);
		} catch (err) {
			this.logService.error('[AIModelService] Failed to initialize provider:', err);
		}
	}

	private _ensureProvider(): IAIProvider {
		if (!this._provider) {
			throw new Error('AI provider not initialized. Configure ai.apiKey in Settings.');
		}
		return this._provider;
	}
}
