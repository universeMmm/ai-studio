/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import {
	AI_STUDIO_VENDOR_ID,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelsService,
	IUserFriendlyLanguageModel,
} from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';
import { BUILTIN_PROVIDERS } from './providerDefinitions.js';

/**
 * Provides user-configured custom models from languageModels.json as selectable
 * chat models in the model picker. Each user-configured group under the
 * `ai-studio` vendor is surfaced as an individual model.
 */
export class CustomModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
	) {
		super();
		this._register(languageModelsConfigurationService.onDidChangeLanguageModelGroups(() => {
			this._onDidChange.fire();
		}));
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);

		const models: ILanguageModelChatMetadataAndIdentifier[] = [];

		for (const group of groups) {
			const settings = group.settings?.[group.name] ?? {};
			const modelId = (settings['modelId'] as string) || group.name;

			models.push({
				identifier: `${AI_STUDIO_VENDOR_ID}:${group.name}`,
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: group.name,
					id: group.name,
					vendor: AI_STUDIO_VENDOR_ID,
					version: '1.0',
					family: modelId,
					maxInputTokens: 128000,
					maxOutputTokens: 16384,
					isDefaultForLocation: {},
					isUserSelectable: true,
					targetChatSessionType: undefined,
					capabilities: {
						vision: settings['vision'] === true,
						toolCalling: true,
						agentMode: true,
					},
				},
			});
		}

		return models;
	}

	async sendChatRequest(): Promise<never> {
		throw new Error('Custom models do not support direct chat requests - chat is handled by the agent host');
	}

	async provideTokenCount(): Promise<number> {
		return 0;
	}
}

/**
 * Registers the AI Studio vendor descriptor and custom model provider
 * so that user-configured models appear in the chat model picker.
 * Returns a disposable that cleans up both the provider and vendor descriptor.
 */
export function registerCustomModelProvider(
	languageModelsService: ILanguageModelsService,
	provider: CustomModelProvider,
): IDisposable {
	const vendorDescriptor: IUserFriendlyLanguageModel = {
		vendor: AI_STUDIO_VENDOR_ID,
		displayName: 'AI Studio',
		configuration: {
			type: 'object',
			properties: {
				providerKey: { type: 'string', enum: BUILTIN_PROVIDERS.map(provider => provider.key), description: localize('studio.model.providerPreset', '供应商预设') },
				modelId: { type: 'string', description: localize('studio.model.modelId', '模型标识符') },
				apiKey: { type: 'string', description: localize('studio.model.key', '模型服务的 API 密钥'), secret: true },
				endpoint: { type: 'string', description: localize('studio.model.endpoint', '模型服务的 API 地址') },
				apiType: { type: 'string', enum: ['openai', 'anthropic'], description: localize('studio.model.apiType', '接口类型') },
				vision: { type: 'boolean', default: false, description: localize('studio.model.vision', '此模型支持图片输入（以模型提供商的能力说明为准）') },
			},
		},
		managementCommand: undefined,
		when: undefined,
	};
	languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
	const providerDisposable = languageModelsService.registerLanguageModelProvider(AI_STUDIO_VENDOR_ID, provider);
	// The configuration may have loaded before this provider was registered, so
	// waiting only for subsequent group changes can leave the initial picker empty.
	void languageModelsService.selectLanguageModels({ vendor: AI_STUDIO_VENDOR_ID }).catch(onUnexpectedError);

	return toDisposable(() => {
		providerDisposable.dispose();
		languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor]);
	});
}
