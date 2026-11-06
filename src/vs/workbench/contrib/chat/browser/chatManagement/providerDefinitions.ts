/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../../base/common/types.js';

export interface ProviderDefinition {
	/** Display name in the dropdown */
	readonly label: string;
	/** Provider key (stored in settings) */
	readonly key: string;
	/** Default API base URL */
	readonly baseUrl: string;
	/** API type: 'openai' for OpenAI-compatible, 'anthropic' for Anthropic Messages */
	readonly apiType: 'openai' | 'anthropic';
	/** Local SVG file in media/providerLogos. Custom providers keep the AI fallback. */
	readonly logo?: string;
}

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
	{
		label: 'OpenAI',
		key: 'openai',
		logo: 'openai.svg',
		baseUrl: 'https://api.openai.com/v1',
		apiType: 'openai',
	},
	{
		label: 'Anthropic',
		key: 'anthropic',
		logo: 'anthropic.svg',
		baseUrl: 'https://api.anthropic.com',
		apiType: 'anthropic',
	},
	{
		label: 'DeepSeek (OpenAI 兼容)',
		key: 'deepseek',
		logo: 'deepseek.svg',
		baseUrl: 'https://api.deepseek.com',
		apiType: 'openai',
	},
	{
		label: 'DeepSeek (Anthropic 兼容)',
		key: 'deepseek-anthropic',
		logo: 'deepseek.svg',
		baseUrl: 'https://api.deepseek.com/anthropic',
		apiType: 'anthropic',
	},
	{
		label: 'OpenRouter',
		key: 'openrouter',
		logo: 'openrouter.svg',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiType: 'openai',
	},
	{
		label: 'Groq',
		key: 'groq',
		logo: 'groq.svg',
		baseUrl: 'https://api.groq.com/openai/v1',
		apiType: 'openai',
	},
	{
		label: 'Groq (Anthropic 兼容)',
		key: 'groq-anthropic',
		logo: 'groq.svg',
		baseUrl: 'https://api.groq.com/anthropic/v1',
		apiType: 'anthropic',
	},
	{
		label: 'xAI (Grok)',
		key: 'xai',
		logo: 'xai.svg',
		baseUrl: 'https://api.x.ai/v1',
		apiType: 'openai',
	},
	{
		label: 'Mistral',
		key: 'mistral',
		logo: 'mistral.svg',
		baseUrl: 'https://api.mistral.ai/v1',
		apiType: 'openai',
	},
	{
		label: 'Together AI',
		key: 'together',
		logo: 'together.svg',
		baseUrl: 'https://api.together.xyz/v1',
		apiType: 'openai',
	},
	{
		label: 'Fireworks AI',
		key: 'fireworks',
		logo: 'fireworks.svg',
		baseUrl: 'https://api.fireworks.ai/inference/v1',
		apiType: 'openai',
	},
	{
		label: 'Ollama (本地)',
		key: 'ollama',
		logo: 'ollama.svg',
		baseUrl: 'http://localhost:11434/v1',
		apiType: 'openai',
	},
	{
		label: '自定义',
		key: 'custom',
		baseUrl: '',
		apiType: 'openai',
	},
];

export function findProviderByKey(key: string): ProviderDefinition | undefined {
	return BUILTIN_PROVIDERS.find(p => p.key === key);
}

/** Explicit custom choices stay custom; legacy profiles match only their exact endpoint and protocol. */
export function findConfiguredProvider(settings: Readonly<Record<string, unknown>>): ProviderDefinition | undefined {
	if (hasKey(settings, { providerKey: true })) {
		return typeof settings['providerKey'] === 'string' ? findProviderByKey(settings['providerKey']) : undefined;
	}
	const endpoint = normalizeProviderEndpoint(settings['endpoint']);
	if (!endpoint) { return undefined; }
	return BUILTIN_PROVIDERS.find(provider => provider.key !== 'custom'
		&& provider.apiType === settings['apiType']
		&& normalizeProviderEndpoint(provider.baseUrl) === endpoint);
}

function normalizeProviderEndpoint(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) { return undefined; }
	try {
		const url = new URL(value.trim());
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { return undefined; }
		return url.origin + url.pathname.replace(/\/+$/, '');
	} catch { return undefined; }
}
