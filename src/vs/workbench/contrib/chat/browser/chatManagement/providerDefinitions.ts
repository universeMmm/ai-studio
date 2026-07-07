/*---------------------------------------------------------------------------------------------
 *  AI Studio — Provider Definitions
 *  Curated list of popular model providers with pre-configured defaults.
 *--------------------------------------------------------------------------------------------*/

export interface ProviderDefinition {
	/** Display name in the dropdown */
	readonly label: string;
	/** Provider key (stored in settings) */
	readonly key: string;
	/** Default API base URL */
	readonly baseUrl: string;
	/** API type: 'openai' for OpenAI-compatible, 'anthropic' for Anthropic Messages */
	readonly apiType: 'openai' | 'anthropic';
}

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
	{
		label: 'OpenAI',
		key: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		apiType: 'openai',
	},
	{
		label: 'Anthropic',
		key: 'anthropic',
		baseUrl: 'https://api.anthropic.com',
		apiType: 'anthropic',
	},
	{
		label: 'DeepSeek (OpenAI 兼容)',
		key: 'deepseek',
		baseUrl: 'https://api.deepseek.com',
		apiType: 'openai',
	},
	{
		label: 'DeepSeek (Anthropic 兼容)',
		key: 'deepseek-anthropic',
		baseUrl: 'https://api.deepseek.com/anthropic',
		apiType: 'anthropic',
	},
	{
		label: 'OpenRouter',
		key: 'openrouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiType: 'openai',
	},
	{
		label: 'Groq',
		key: 'groq',
		baseUrl: 'https://api.groq.com/openai/v1',
		apiType: 'openai',
	},
	{
		label: 'Groq (Anthropic 兼容)',
		key: 'groq-anthropic',
		baseUrl: 'https://api.groq.com/anthropic/v1',
		apiType: 'anthropic',
	},
	{
		label: 'xAI (Grok)',
		key: 'xai',
		baseUrl: 'https://api.x.ai/v1',
		apiType: 'openai',
	},
	{
		label: 'Mistral',
		key: 'mistral',
		baseUrl: 'https://api.mistral.ai/v1',
		apiType: 'openai',
	},
	{
		label: 'Together AI',
		key: 'together',
		baseUrl: 'https://api.together.xyz/v1',
		apiType: 'openai',
	},
	{
		label: 'Fireworks AI',
		key: 'fireworks',
		baseUrl: 'https://api.fireworks.ai/inference/v1',
		apiType: 'openai',
	},
	{
		label: 'Ollama (本地)',
		key: 'ollama',
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
