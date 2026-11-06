/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AIReasoningEffort = 'default' | 'low' | 'medium' | 'high';

function modelName(model: string): string { return model.toLowerCase().split('/').pop() ?? ''; }

export function isDeepSeekEndpoint(apiBase: string): boolean {
	try { const host = new URL(apiBase).hostname; return host === 'api.deepseek.com' || host.endsWith('.deepseek.com'); }
	catch { return false; }
}

export function isDeepSeekReasoningModel(model: string, apiBase = ''): boolean {
	return isDeepSeekEndpoint(apiBase) || /^deepseek-(?:chat|reasoner|flash|v4(?:-pro|-flash)?)(?:$|-)/.test(modelName(model));
}

function isOpenAIReasoningModel(model: string): boolean {
	// Only the Chat Completions models whose tool protocol this provider implements.
	// Responses-only Codex/pro models and future families must not inherit these capabilities.
	return /^(?:o1|o3|o3-mini|o4-mini|gpt-5(?:-mini|-nano|\.1|\.2)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelName(model));
}

function hasAnthropicEffort(model: string): boolean {
	return /^claude-(?:opus-4[.-][5678]|sonnet-4[.-]6)(?:$|-\d{8}$)/.test(modelName(model));
}

/** UI and request serialization share one conservative capability table. */
export function getAIReasoningEfforts(apiType: string, model: string, apiBase = ''): readonly AIReasoningEffort[] {
	if (!model) { return ['default']; }
	if (apiType === 'openai' && isDeepSeekReasoningModel(model, apiBase)) { return ['default', 'low', 'high']; }
	if ((apiType === 'openai' && isOpenAIReasoningModel(model)) || (apiType === 'anthropic' && !isDeepSeekEndpoint(apiBase) && hasAnthropicEffort(model))) {
		return ['default', 'low', 'medium', 'high'];
	}
	return ['default'];
}

export function normalizeAIReasoningEffort(value: unknown, allowed: readonly AIReasoningEffort[]): AIReasoningEffort {
	return allowed.includes(value as AIReasoningEffort) ? value as AIReasoningEffort : 'default';
}

/** Preserve the shared fetch transport; only map documented request fields. */
export function applyOpenAIReasoning(body: Record<string, unknown>, model: string, apiBase: string, value: unknown): void {
	const effort = normalizeAIReasoningEffort(value, getAIReasoningEfforts('openai', model, apiBase));
	if (isDeepSeekReasoningModel(model, apiBase)) {
		delete body.temperature;
		if (effort !== 'default') { body.thinking = { type: 'enabled' }; body.reasoning_effort = effort; }
	} else if (isOpenAIReasoningModel(model)) {
		body.max_completion_tokens = body.max_tokens;
		delete body.max_tokens;
		delete body.temperature;
		if (effort !== 'default') { body.reasoning_effort = effort; }
	}
}

export function applyAnthropicEffort(body: Record<string, unknown>, model: string, apiBase: string, value: unknown): void {
	const effort = normalizeAIReasoningEffort(value, getAIReasoningEfforts('anthropic', model, apiBase));
	// Effort is supported independently of extended thinking on these Claude 4.x models.
	// Enabling adaptive thinking also requires signed thinking-block round trips.
	if (effort !== 'default') { body.output_config = { effort }; }
	if (/^claude-opus-4[.-][78](?:$|-)/.test(modelName(model))) { delete body.temperature; }
}
