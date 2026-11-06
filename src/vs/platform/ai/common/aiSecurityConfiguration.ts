/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '../../configuration/common/configuration.js';
import type { AIProviderId } from './aiTypes.js';

/** Credentials and execution policy must never inherit repository configuration. */
export function getUserAIConfiguration<T>(configuration: IConfigurationService, key: string, fallback: T): T {
	const inspected = configuration.inspect<T>(key);
	return inspected.policyValue ?? inspected.userValue ?? inspected.applicationValue ?? inspected.defaultValue ?? fallback;
}

export interface AICredentialTarget {
	readonly provider: AIProviderId;
	readonly origin: string;
}

export function getAICredentialTarget(provider: string, apiBase: string): AICredentialTarget {
	if (provider !== 'openai' && provider !== 'anthropic') {
		throw new Error('Unsupported AI provider.');
	}
	const endpoint = new URL(apiBase || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'));
	if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
		throw new Error('The model endpoint must be an HTTP(S) URL without embedded credentials.');
	}
	return { provider, origin: endpoint.origin };
}

export function getConfiguredAICredentialTarget(configuration: IConfigurationService): AICredentialTarget {
	return getAICredentialTarget(
		getUserAIConfiguration(configuration, 'ai.apiType', 'openai'),
		getUserAIConfiguration(configuration, 'ai.apiBase', ''),
	);
}
