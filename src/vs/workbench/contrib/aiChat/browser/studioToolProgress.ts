/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Adapt runtime tool calls to persistent workbench activity and approval controls.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import type { AgentStep } from '../../../../platform/ai/common/aiTypes.js';
import { IChatToolInvocation, ToolConfirmKind, type IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatToolInvocation } from '../../chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';

import { studioToolLabel } from './studioToolLabels.js';

export class StudioToolProgress {
	private readonly calls = new Map<string, ChatToolInvocation>();

	constructor(
		private readonly requestId: string,
		private readonly progress: (parts: IChatProgress[]) => void,
	) { }

	start(step: AgentStep): void {
		if (!step.toolCallId || !step.toolName) { return; }
		const args = step.toolInput ?? {};
		const label = studioToolLabel(step.toolName, args);
		const data = { id: step.toolName, displayName: label, modelDescription: studioToolLabel(step.toolName), source: ToolDataSource.Internal };
		const invocation = step.toolName === 'run_command'
			? ChatToolInvocation.createStreaming({ toolCallId: step.toolCallId, toolId: step.toolName, toolData: data, chatRequestId: this.requestId })
			: new ChatToolInvocation({ invocationMessage: label }, data, step.toolCallId, undefined, args, {}, this.requestId);
		invocation.parameters = args;
		this.calls.set(step.toolCallId, invocation);
		this.progress([invocation]);
	}

	async approve(command: { toolCallId: string; command: string; cwd: string; requestId: string }, token: CancellationToken): Promise<boolean> {
		if (token.isCancellationRequested) { return false; }
		const message = new MarkdownString().appendText(localize('studio.cwd', "工作目录：{0}", command.cwd)).appendCodeblock('sh', command.command);
		const prepared = {
			invocationMessage: localize('studio.command', "运行命令"),
			confirmationMessages: { title: localize('studio.approval', "允许运行这条命令吗？"), message, allowAutoConfirm: false },
		};
		const args = { command: command.command, cwd: command.cwd };
		const current = this.calls.get(command.toolCallId);
		const shellCall = current?.toolId === 'run_command' && current.state.get().type === IChatToolInvocation.StateKind.Streaming;
		let invocation: ChatToolInvocation;
		if (current && shellCall) {
			invocation = current;
			invocation.transitionFromStreaming(prepared, args, undefined);
		} else {
			// A delegated agent can ask for permission during its parent tool invocation.
			invocation = new ChatToolInvocation(prepared, {
				id: 'run_command', displayName: prepared.invocationMessage,
				modelDescription: prepared.invocationMessage, source: ToolDataSource.Internal, icon: Codicon.terminal
			},
				command.requestId, undefined, args, {}, this.requestId);
			this.calls.set(command.requestId, invocation);
			this.progress([invocation]);
		}
		const reason = await IChatToolInvocation.awaitConfirmation(invocation, token);
		const allowed = !token.isCancellationRequested && reason.type === ToolConfirmKind.UserAction;
		if (!allowed) { IChatToolInvocation.confirmWith(invocation, { type: ToolConfirmKind.Denied }); }
		if (!shellCall) {
			if (allowed) { await invocation.didExecuteTool({ content: [], toolResultMessage: localize('studio.approved', "已允许子智能体运行命令") }); }
			this.calls.delete(command.requestId);
		}
		return allowed;
	}

	finish(step: AgentStep): void {
		const id = step.toolCallId;
		const invocation = id ? this.calls.get(id) : undefined;
		if (!id || !invocation) { return; }
		this.calls.delete(id);
		if (invocation.state.get().type === IChatToolInvocation.StateKind.Cancelled) { return; }
		const args = invocation.parameters as Record<string, unknown>;
		invocation.transitionFromStreaming({ invocationMessage: studioToolLabel(invocation.toolId, args) }, args, undefined);
		const title = studioToolLabel(invocation.toolId, args);
		void invocation.didExecuteTool({
			content: [{ kind: 'text', value: step.content }],
			toolResultMessage: step.isError ? localize('studio.toolFailed', "失败 · {0}", title) : title,
			toolResultError: step.isError,
			toolResultDetails: { input: JSON.stringify(args, null, 2), output: [{ type: 'embed', value: step.content, isText: true }], isError: step.isError }
		});
	}

	dispose(): void {
		for (const invocation of this.calls.values()) {
			if (invocation.cancelFromStreaming(ToolConfirmKind.Skipped) || IChatToolInvocation.confirmWith(invocation, { type: ToolConfirmKind.Denied })) { continue; }
			if (invocation.state.get().type === IChatToolInvocation.StateKind.Executing) {
				void invocation.didExecuteTool({ content: [], toolResultMessage: localize('studio.stopped', "工具已停止") });
			}
		}
		this.calls.clear();
	}
}
