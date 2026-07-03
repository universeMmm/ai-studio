/*---------------------------------------------------------------------------------------------
 *  AI Studio — Credential Service
 *  Stores API keys via VS Code SecretStorage with settings fallback.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';

export const IAIKeychainService = createDecorator<IAIKeychainService>('aiKeychainService');

export interface IAIKeychainService {
	readonly _serviceBrand: undefined;
	getApiKey(): Promise<string | undefined>;
	setApiKey(apiKey: string): Promise<void>;
	deleteApiKey(): Promise<void>;
}

export class AIKeychainService extends Disposable implements IAIKeychainService {
	declare readonly _serviceBrand: undefined;
	private static readonly SECRET_KEY = 'ai-studio.apiKey';

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) { super(); }

	async getApiKey(): Promise<string | undefined> {
		try {
			const stored = await this.secretStorageService.get(AIKeychainService.SECRET_KEY);
			if (stored) return stored;
		} catch (err) {
			this.logService.warn('[AIKeychain] SecretStorage unavailable, falling back to settings.');
		}
		const cfgKey = this.configurationService.getValue<string>('ai.apiKey');
		return cfgKey || undefined;
	}

	async setApiKey(apiKey: string): Promise<void> {
		try {
			await this.secretStorageService.set(AIKeychainService.SECRET_KEY, apiKey);
		} catch (err) {
			this.logService.warn('[AIKeychain] Cannot store API key securely. Use ai.apiKey in settings as fallback.');
			await this.configurationService.updateValue('ai.apiKey', apiKey);
		}
	}

	async deleteApiKey(): Promise<void> {
		try {
			await this.secretStorageService.delete(AIKeychainService.SECRET_KEY);
		} catch {
			// Key already gone or storage unavailable
		}
	}
}
