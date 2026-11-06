/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { hash } from '../../../../base/common/hash.js';
import type { AgentExternalTool } from '../../../../platform/ai/browser/aiAgentService.js';
import type { AIMessageContent, AITool } from '../../../../platform/ai/common/aiTypes.js';
import type { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { ILanguageModelsService, LanguageModelPartAudience } from '../../chat/common/languageModels.js';
import { ILanguageModelToolsService, isToolResultInputOutputDetails, stringifyPromptTsxPart } from '../../chat/common/tools/languageModelToolsService.js';

/** Only adapt the catalog; the existing MCP/tool service owns execution and approvals. */
export function createStudioMcpTools(request: IChatAgentRequest, tools: ILanguageModelToolsService, models: ILanguageModelsService): AgentExternalTool[] {
	const model = request.userSelectedModelId ? models.lookupLanguageModel(request.userSelectedModelId) : undefined;
	return Array.from(tools.getTools(model)).filter(tool => tool.source.type === 'mcp' && request.userSelectedTools?.[tool.id] !== false).map(tool => ({
		definition: {
			name: 'mcp_' + (tool.toolReferenceName || tool.displayName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42) + '_' + (hash(tool.id) >>> 0).toString(16),
			description: `${tool.source.label}: ${tool.modelDescription}`,
			// Preserve full MCP JSON Schema verbatim. The core's built-in-only
			// schema validator is deliberately not applied to external tools.
			input_schema: (tool.inputSchema ?? { type: 'object', properties: {}, required: [] }) as AITool['input_schema'],
		},
		async invoke(call, signal) {
			if (signal.aborted) { return { text: 'Tool cancelled.', outcome: 'cancelled' }; }
			if (request.userSelectedTools?.[tool.id] === false || !Array.from(tools.getTools(model)).some(current => current.id === tool.id && current.source.type === 'mcp')) {
				return { text: 'This MCP tool is no longer enabled.', outcome: 'denied' };
			}
			const cancellation = new CancellationTokenSource();
			const cancel = () => cancellation.cancel();
			signal.addEventListener('abort', cancel, { once: true });
			try {
				const result = await tools.invokeTool({
					callId: call.id, toolId: tool.id, parameters: call.input,
					context: { sessionResource: request.sessionResource, workingDirectory: request.workingDirectory },
					chatRequestId: request.requestId, modelId: request.userSelectedModelId, userSelectedTools: request.userSelectedTools,
				}, async text => Math.ceil(text.length / 3), cancellation.token);
				const text: string[] = [];
				const images: AIMessageContent[] = [];
				for (const part of result.content) {
					if (part.kind !== 'promptTsx' && part.audience?.length && !part.audience.includes(LanguageModelPartAudience.Assistant)) { continue; }
					if (part.kind === 'text') { text.push(part.value); }
					else if (part.kind === 'promptTsx') { text.push(stringifyPromptTsxPart(part)); }
					else if (/^image\/(png|jpeg|gif|webp)$/.test(part.value.mimeType) && part.value.data.byteLength <= 5 * 1024 * 1024 && images.length < 4) {
						images.push({ type: 'image', source: { type: 'base64', media_type: part.value.mimeType, data: encodeBase64(part.value.data) } });
					} else if (part.value.mimeType === 'application/json' || part.value.mimeType.startsWith('text/')) {
						text.push(part.value.data.toString());
					} else { text.push(`[${part.value.mimeType} output is available in the tool result.]`); }
				}
				const failed = !!result.toolResultError || (isToolResultInputOutputDetails(result.toolResultDetails) && result.toolResultDetails.isError === true);
				return { text: text.join('\n') || (typeof result.toolResultError === 'string' ? result.toolResultError : failed ? 'MCP tool failed.' : 'MCP tool completed.'), images, outcome: signal.aborted ? 'cancelled' : failed ? 'error' : 'success' };
			} catch (error) {
				return { text: signal.aborted ? 'Tool cancelled.' : isCancellationError(error) ? 'The user declined this tool call.' : error instanceof Error ? error.message : String(error), outcome: signal.aborted ? 'cancelled' : isCancellationError(error) ? 'denied' : 'error' };
			} finally {
				signal.removeEventListener('abort', cancel);
				cancellation.dispose();
			}
		},
	}));
}
