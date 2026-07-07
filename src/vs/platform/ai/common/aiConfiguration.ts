/*---------------------------------------------------------------------------------------------
 *  AI Studio - Configuration Registration
 *  Exposes ai.* settings in VS Code''s Settings UI.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationNode } from "../../../platform/configuration/common/configurationRegistry.js";

export const aiConfigurationNode: IConfigurationNode = {
	id: "ai",
	order: 50,
	title: "AI",
	type: "object",
	properties: {
		"ai.modelName": {
			type: "string",
			default: "",
			description: "AI model display name shown in the status bar. Leave empty to show the model ID.",
		},
		"ai.apiType": {
			type: "string",
			enum: ["openai", "anthropic"],
			default: "openai",
			description: "API type. \"openai\" for OpenAI or any OpenAI-compatible API (OpenRouter, DeepSeek, Ollama, etc.). \"anthropic\" for the official Anthropic API.",
			enumDescriptions: [
				"OpenAI or any OpenAI-compatible API endpoint",
				"Anthropic official API",
			],
		},
		"ai.modelId": {
			type: "string",
			default: "",
			description: "Model identifier. A single model is shared across all features (Chat, Agent, inline completion).",
		},
		"ai.apiKey": {
			type: "string",
			default: "",
			description: "Legacy fallback API key for the selected provider. Prefer storing keys in AI Studio secure credentials instead of settings.",
		},
		"ai.apiBase": {
			type: "string",
			default: "",
			description: "Custom API base URL. Leave empty to use the official endpoint. Example: https://api.openrouter.ai/v1",
		},
		"ai.completion.enabled": {
			type: "boolean",
			default: true,
			description: "Enable inline Tab code completion.",
		},
		"ai.completion.delay": {
			type: "number",
			default: 150,
			minimum: 50,
			maximum: 2000,
			description: "Delay in milliseconds before triggering a completion request after the user stops typing.",
		},
		"ai.chat.maxTokens": {
			type: "number",
			default: 16000,
			minimum: 256,
			maximum: 200000,
			description: "Maximum tokens per chat response.",
		},
		"ai.agent.maxSteps": {
			type: "number",
			default: 20,
			minimum: 1,
			maximum: 100,
			description: "Maximum number of steps the agent may take before being force-stopped.",
		},
		"ai.commandApproval": {
			type: "string",
			enum: ["all", "unsafe", "none"],
			default: "unsafe",
			description: "Command execution approval policy. \"unsafe\" approves only read-only/safe commands automatically. \"all\" requires approval for every command. \"none\" disables approval (not recommended).",
			enumDescriptions: [
				"Approve every shell command before execution",
				"Auto-approve safe/read-only commands, require approval for potentially destructive ones",
				"Skip all approval - execute any command automatically",
			],
		},
		"ai.index.enabled": {
			type: "boolean",
			default: true,
			description: "Enable codebase indexing so the AI understands your project structure.",
		},
	},
};
