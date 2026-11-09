/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Configuration Registration
 *  Exposes ai.* settings in VS Code''s Settings UI.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ConfigurationScope, type IConfigurationNode } from '../../../platform/configuration/common/configurationRegistry.js';

export const aiConfigurationNode: IConfigurationNode = {
	id: 'ai',
	order: 50,
	title: 'AI',
	type: 'object',
	properties: {
		'ai.modelName': {
			scope: ConfigurationScope.MACHINE,
			type: 'string',
			default: '',
			description: localize("studio.settings.modelName", "状态栏显示的模型名称。留空时显示模型 ID。"),
		},
		'ai.apiType': {
			scope: ConfigurationScope.MACHINE,
			restricted: true,
			type: 'string',
			enum: ['openai', 'anthropic'],
			enumItemLabels: ['OpenAI', 'Anthropic'],
			default: 'openai',
			description: localize("studio.settings.apiType", "选择模型接口类型。OpenAI 兼容接口也适用于 OpenRouter、DeepSeek 和 Ollama。"),
			enumDescriptions: [
				localize("studio.settings.openAi", "OpenAI 或兼容 OpenAI 的接口"),
				localize("studio.settings.anthropic", "Anthropic 官方接口"),
			],
		},
		'ai.modelId': {
			scope: ConfigurationScope.MACHINE,
			type: 'string',
			default: '',
			description: localize("studio.settings.modelId", "模型标识符。对话、智能体和行内补全共用此模型。"),
		},
		'ai.apiKey': {
			scope: ConfigurationScope.MACHINE,
			type: 'string',
			default: '',
			description: localize("studio.settings.apiKey", "兼容旧版设置的 API 密钥。建议将密钥保存到 AI Studio 的安全凭据中。"),
			restricted: true,
			ignoreSync: true,
		},
		'ai.apiBase': {
			scope: ConfigurationScope.MACHINE,
			restricted: true,
			type: 'string',
			default: '',
			description: localize("studio.settings.apiBase", "模型服务的 API 地址。留空时使用所选服务的官方地址。"),
		},
		'ai.modelContextTokens': {
			type: 'number',
			scope: ConfigurationScope.MACHINE,
			default: 128000,
			minimum: 4096,
			maximum: 2000000,
			description: localize('studio.settings.modelContextTokens', '当前模型的上下文窗口大小。请按模型服务提供的上限填写。'),
		},
		'ai.reasoningEffort': {
			type: 'string',
			scope: ConfigurationScope.MACHINE,
			default: 'default',
			enum: ['default', 'low', 'medium', 'high'],
			enumItemLabels: ['默认', '低', '中', '高'],
			description: localize('studio.settings.reasoningEffort', '当前模型的推理强度。仅向已确认支持的模型发送参数；默认由模型服务决定。'),
		},
		'ai.completion.enabled': {
			type: 'boolean',
			default: true,
			description: localize("studio.settings.completionEnabled", "启用按 Tab 接受的行内代码补全。"),
		},
		'ai.completion.delay': {
			type: 'number',
			default: 150,
			minimum: 50,
			maximum: 2000,
			description: localize("studio.settings.completionDelay", "停止输入后等待多少毫秒再请求补全。"),
		},
		'ai.chat.maxTokens': {
			type: 'number',
			default: 16000,
			minimum: 256,
			maximum: 200000,
			description: localize("studio.settings.chatMaxTokens", "每次对话回复最多可使用的词元数。"),
		},
		'ai.agent.maxSteps': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 100,
			description: localize("studio.settings.agentMaxSteps", "智能体每次任务最多可执行的步骤数。"),
		},
		'ai.agent.maxSubAgents': {
			type: 'number',
			default: 3,
			minimum: 1,
			maximum: 16,
			description: localize("studio.settings.maxSubAgents", "可同时运行的子智能体数量上限。"),
		},
		'ai.commandApproval': {
			scope: ConfigurationScope.MACHINE,
			restricted: true,
			type: 'string',
			enum: ['all', 'unsafe', 'none'],
			enumItemLabels: [
				localize("studio.settings.confirmAlways", "逐条审批"),
				localize("studio.settings.confirmUnsafe", "按需审批"),
				localize("studio.settings.confirmNever", "自动执行"),
			],
			default: 'unsafe',
			description: localize("studio.settings.commandApproval", "选择运行终端命令时的审批方式。"),
			enumDescriptions: [
				localize("studio.settings.approveAll", "运行每条命令前请求批准"),
				localize("studio.settings.approveUnsafe", "自动放行已识别的只读命令，其他命令需要批准"),
				localize("studio.settings.approveNone", "自动运行允许执行的命令"),
			],
		},
		'ai.slashCommands': {
			type: 'object',
			default: {},
			markdownDescription: localize("studio.settings.slashCommands", "自定义斜杠命令。键为命令名称（省略 /），值包含必填的 `prompt` 和可选的 `description`。例如 `{ \"test\": { \"description\": \"运行测试\", \"prompt\": \"请运行项目测试并汇总结果\" } }`。"),
		},
		'ai.index.enabled': {
			type: 'boolean',
			default: true,
			description: localize("studio.settings.indexEnabled", "为工作区代码建立索引，以便智能体检索项目结构与实现。"),
		},
		'ai.index.maxFiles': {
			scope: ConfigurationScope.RESOURCE,
			type: 'number', default: 10000, minimum: 1, maximum: 100000,
			description: localize('studio.settings.indexMaxFiles', '每个工作区目录最多索引的文件数。超过上限时按路径排序选取。'),
		},
		'ai.index.batchSize': {
			scope: ConfigurationScope.RESOURCE,
			type: 'number', default: 16, minimum: 1, maximum: 128,
			description: localize('studio.settings.indexBatchSize', '每次 Embedding 请求最多包含的代码块数。'),
		},
		'ai.index.maxMemoryMB': {
			scope: ConfigurationScope.RESOURCE,
			type: 'number', default: 256, minimum: 16, maximum: 4096,
			description: localize('studio.settings.indexMaxMemory', '每个目录的索引内存预算（MiB），包括向量、文本和条目开销估算，不代表整个进程内存。达到预算时暂停添加条目；降低预算会裁剪持久化索引，可提高预算后重新生成。'),
		},
		'ai.index.requestInterval': {
			scope: ConfigurationScope.RESOURCE,
			type: 'number', default: 200, minimum: 0, maximum: 60000,
			description: localize('studio.settings.indexRequestInterval', '同一目录的 Embedding 请求最小间隔，单位毫秒。'),
		},
		'ai.index.include': {
			scope: ConfigurationScope.RESOURCE,
			type: 'array', items: { type: 'string' }, default: ['**/*'],
			description: localize('studio.settings.indexInclude', '允许索引的相对路径 glob。仍遵循 Git 忽略规则。'),
		},
		'ai.index.exclude': {
			scope: ConfigurationScope.RESOURCE,
			type: 'array', items: { type: 'string' }, default: [],
			description: localize('studio.settings.indexExclude', '额外排除的相对路径 glob；同时使用 files.exclude 和 search.exclude 中值为 true 的规则。'),
		},
	},
};
