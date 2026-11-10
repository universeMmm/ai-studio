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
import { getAICredentialTarget, getConfiguredAICredentialTarget, type AICredentialTarget } from '../common/aiSecurityConfiguration.js';

export const IAIKeychainService = createDecorator<IAIKeychainService>('aiKeychainService');

export interface IAIKeychainService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeApiKey: Event<void>;
	getApiKey(target?: AICredentialTarget): Promise<string | undefined>;
	setApiKey(apiKey: string, target?: AICredentialTarget, options?: { requirePersisted: boolean }): Promise<void>;
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
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (key.startsWith('ai-studio.apiKey.v2:')) { this._onDidChangeApiKey.fire(); }
		}));
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

	async setApiKey(apiKey: string, target = getConfiguredAICredentialTarget(this.configurationService), options?: { requirePersisted: boolean }): Promise<void> {
		if (typeof apiKey !== 'string' || !apiKey.trim()) { throw new Error('API key must not be empty.'); }
		const key = this._secretKey(target);
		await this._migration;
		if (options?.requirePersisted) {
			await this.secretStorageService.get(key); // Initialize the storage backend before checking it.
			if (this.secretStorageService.type !== 'persisted') { throw new Error('Persistent secret storage is required to replace a legacy credential.'); }
		}
		// A secure-store failure must never write a new key to plaintext settings.
		await this.secretStorageService.set(key, apiKey);
		if (options?.requirePersisted && await this.secretStorageService.get(key) !== apiKey) { throw new Error('Credential storage could not be verified.'); }
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
		// Migrate only the local user's old value, never a policy/default/remote value.
		const configuredKey = this.configurationService.inspect<string>('ai.apiKey').userLocalValue;
		// The old global ai-studio.apiKey secret has no provider/profile/origin metadata.
		// Different windows may have different endpoints, so guessing a destination (or
		// using a renderer-local migration lock) could disclose that key to another origin.
		// Preserve it for recovery; the model form explicitly saves a bound replacement.
		if (typeof configuredKey !== 'string' || !configuredKey.trim()) { return; }
		const endpoint = this.configurationService.inspect<string>('ai.apiBase');
		const provider = this.configurationService.inspect<string>('ai.apiType');
		// A destination previously supplied only by a repository has no trustworthy binding.
		const ambiguous = [endpoint, provider].some(value => value.userLocalValue === undefined
			&& (value.userRemoteValue !== undefined || value.workspaceValue !== undefined || value.workspaceFolderValue !== undefined));
		if (ambiguous) { return; }
		const target = getAICredentialTarget(provider.userLocalValue ?? 'openai', endpoint.userLocalValue ?? '');
		const destination = this._secretKey(target);
		const existing = await this.secretStorageService.get(destination);
		// An ephemeral store cannot safely replace the only persisted copy of a key.
		if (this.secretStorageService.type !== 'persisted') { return; }
		if (!existing) {
			await this.secretStorageService.set(destination, configuredKey);
		}
		// Read back before deleting plaintext. Keep a conflicting legacy value recoverable.
		if (await this.secretStorageService.get(destination) === configuredKey
			&& this.configurationService.inspect<string>('ai.apiKey').userLocalValue === configuredKey) {
			await this.configurationService.updateValue('ai.apiKey', undefined, ConfigurationTarget.USER_LOCAL);
		}
	}
}
