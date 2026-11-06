/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Credential Service
 *  Stores API keys via VS Code SecretStorage, bound to provider and endpoint origin.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { getAICredentialTarget, getConfiguredAICredentialTarget, getUserAIConfiguration, type AICredentialTarget } from '../common/aiSecurityConfiguration.js';

export const IAIKeychainService = createDecorator<IAIKeychainService>('aiKeychainService');

export interface IAIKeychainService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeApiKey: Event<void>;
	getApiKey(target?: AICredentialTarget): Promise<string | undefined>;
	setApiKey(apiKey: string, target?: AICredentialTarget): Promise<void>;
	deleteApiKey(target?: AICredentialTarget): Promise<void>;
}

export class AIKeychainService extends Disposable implements IAIKeychainService {
	declare readonly _serviceBrand: undefined;
	private readonly _migration: Promise<void>;
	private readonly _onDidChangeApiKey = this._register(new Emitter<void>());
	readonly onDidChangeApiKey = this._onDidChangeApiKey.event;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Capture the old user-selected destination before any asynchronous settings changes.
		this._migration = this._migrateLegacyUserSetting().catch(() => {
			this.logService.warn('[AIKeychain] User credential migration could not finish. No plaintext fallback will be used.');
		});
	}

	async getApiKey(target = getConfiguredAICredentialTarget(this.configurationService)): Promise<string | undefined> {
		const key = this._secretKey(target);
		await this._migration;
		return (await this.secretStorageService.get(key)) || undefined;
	}

	async setApiKey(apiKey: string, target = getConfiguredAICredentialTarget(this.configurationService)): Promise<void> {
		const key = this._secretKey(target);
		await this._migration;
		// A secure-store failure must never write a new key to plaintext settings.
		await this.secretStorageService.set(key, apiKey);
		this._onDidChangeApiKey.fire();
	}

	async deleteApiKey(target = getConfiguredAICredentialTarget(this.configurationService)): Promise<void> {
		const key = this._secretKey(target);
		await this._migration;
		await this.secretStorageService.delete(key);
		this._onDidChangeApiKey.fire();
	}

	private _secretKey(target: AICredentialTarget): string {
		const normalized = getAICredentialTarget(target.provider, target.origin);
		return `ai-studio.apiKey.v2:${normalized.provider}:${encodeURIComponent(normalized.origin)}`;
	}

	private async _migrateLegacyUserSetting(): Promise<void> {
		const target = getConfiguredAICredentialTarget(this.configurationService);
		const configuredKey = getUserAIConfiguration(this.configurationService, 'ai.apiKey', '');
		// The old global ai-studio.apiKey secret has no provider/profile/origin metadata.
		// Different windows may have different endpoints, so guessing a destination (or
		// using a renderer-local migration lock) could disclose that key to another origin.
		// Preserve it for recovery; the model form explicitly saves a bound replacement.
		if (!configuredKey) { return; }
		const endpoint = this.configurationService.inspect<string>('ai.apiBase');
		const provider = this.configurationService.inspect<string>('ai.apiType');
		// A destination previously supplied only by a repository has no trustworthy binding.
		const ambiguous = [endpoint, provider].some(value => value.userValue === undefined
			&& (value.workspaceValue !== undefined || value.workspaceFolderValue !== undefined));
		if (ambiguous) { return; }
		const destination = this._secretKey(target);
		if (!await this.secretStorageService.get(destination)) {
			await this.secretStorageService.set(destination, configuredKey);
		}
		if (configuredKey && getUserAIConfiguration(this.configurationService, 'ai.apiKey', '') === configuredKey) {
			await this.configurationService.updateValue('ai.apiKey', undefined, ConfigurationTarget.USER);
		}
	}
}
