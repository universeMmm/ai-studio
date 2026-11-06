/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Chat Agent with Tool-Use Loop
 *  Registers as VS Code's default chat agent. Delegates the agent loop to
 *  IAIAgentService so there is one canonical implementation shared across
 *  the Chat panel, the status bar, and any other surface.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { waitForState } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import type { AgentStep, AskUserQuestionInput } from '../../../../platform/ai/common/aiTypes.js';
import {
	IChatAgentService,
	type IChatAgentData,
	type IChatAgentImplementation,
	type IChatAgentRequest,
	type IChatAgentHistoryEntry,
	type IChatAgentResult,
} from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import type { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatModeKind, ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { StudioToolProgress } from './studioToolProgress.js';
import { IChatTodoListService } from '../../chat/common/tools/chatTodoListService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDiffStore } from '../../aiDiffApply/browser/diffStore.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { resolveStudioAttachments } from './studioAttachments.js';
import { createStudioMcpTools } from './studioMcpTools.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IMcpService } from '../../mcp/common/mcpTypes.js';
import './studioCapabilities.js';

const AI_STUDIO_AGENT_ID = 'ai-studio.chat';

class AIStudioChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiStudioChatAgent';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IChatTodoListService private readonly todos: IChatTodoListService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageModelToolsService private readonly languageModelTools: ILanguageModelToolsService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IMcpService private readonly mcpService: IMcpService,
	) { super(); this._registerAgent(); }

	private _registerAgent(): void {
		const data: IChatAgentData = {
			id: AI_STUDIO_AGENT_ID, name: 'AI Studio', fullName: 'AI Studio',
			description: localize('studio.agent', '帮助你完成任务的智能助手'),
			isDefault: true, isCore: true,
			extensionId: new ExtensionIdentifier('ai-studio'), extensionVersion: '1.0.0',
			extensionPublisherId: 'ai-studio', extensionDisplayName: 'AI Studio', publisherDisplayName: 'AI Studio',
			metadata: { themeIcon: ThemeIcon.fromId('sparkle'), sampleRequest: localize('studio.sample', '帮我整理这个项目的资料'), isSticky: false },
			slashCommands: [], locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline, ChatAgentLocation.Terminal],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			disambiguation: [{ category: 'ai_studio', description: 'AI Studio coding assistant', examples: ['write a function', 'fix this bug', 'explain this code'] }],
		};
		const impl: IChatAgentImplementation = {
			invoke: (request, progress, history, token) => this._invoke(request, progress, history, token),
		};
		this._register(this.chatAgentService.registerAgent(AI_STUDIO_AGENT_ID, data));
		this._register(this.chatAgentService.registerAgentImplementation(AI_STUDIO_AGENT_ID, impl));
	}

	private async _invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const agent = this.instantiationService.invokeFunction(a => a.get(IAIAgentService));
		if (token.isCancellationRequested) { return {}; }
		if (agent.isRunning) {
			return { errorDetails: { message: localize('studio.busy', '智能体正在另一个会话中执行任务。请等待完成，或先停止该任务。') } };
		}

		const attachments = await resolveStudioAttachments(request.variables.variables, this.fileService, token).catch(error => {
			if (token.isCancellationRequested) { return undefined; }
			throw error;
		});
		if (!attachments || token.isCancellationRequested) { return {}; }
		// Reuse native discovery/autostart. Trust and authentication prompts remain
		// in MCP management; an unavailable extension must not stall every chat.
		const discovery = new CancellationTokenSource(token);
		const discoveryTimeout = disposableTimeout(() => discovery.cancel(), 10_000);
		try {
			const state = await waitForState(this.mcpService.autostart(discovery.token), state => !state.working, undefined, discovery.token);
			if (state.serversRequiringInteraction.length) {
				progress([{ kind: 'warning', content: new MarkdownString(localize('studio.mcp.setup', '部分 MCP 连接需要确认或登录。请在「设置 → 能力 → MCP」中完成连接。')) }]);
			}
		} catch {
			if (!token.isCancellationRequested) { progress([{ kind: 'warning', content: new MarkdownString(localize('studio.mcp.timeout', '部分 MCP 连接尚未就绪，将使用当前可用的能力。')) }]); }
		} finally { discoveryTimeout.dispose(); discovery.dispose(true); }
		if (token.isCancellationRequested) { return {}; }
		const externalTools = createStudioMcpTools(request, this.languageModelTools, this.languageModels);
		const externalToolNames = new Set(externalTools.map(tool => tool.definition.name));
		// Attachment reads yield; another composer may have started the shared agent meanwhile.
		if (agent.isRunning) {
			return { errorDetails: { message: localize('studio.busy', '智能体正在另一个会话中执行任务。请等待完成，或先停止该任务。') } };
		}
		for (const warning of attachments.warnings) { progress([{ kind: 'warning', content: new MarkdownString(warning) }]); }
		const instruction = request.message + attachments.text;
		const subscriptions = new DisposableStore();
		const tools = subscriptions.add(new StudioToolProgress(request.requestId, progress));
		let firstThought = true;
		let errorMessage: string | undefined;
		subscriptions.add(agent.onDidAddStep((step: AgentStep) => {
			switch (step.type) {
				case 'thought': {
					const echo = firstThought && step.content === instruction;
					firstThought = false;
					if (!echo) { progress([{ kind: 'markdownContent', content: new MarkdownString(step.content) }]); }
					break;
				}
				// The native tool service already renders MCP progress and approval
				// cards in this request. Do not create a second generic tool card.
				case 'tool_use': if (!externalToolNames.has(step.toolName ?? '')) { tools.start(step); } break;
				case 'tool_result': if (!externalToolNames.has(step.toolName ?? '')) { tools.finish(step); } break;
				case 'error': errorMessage = step.content; break;
			}
		}));
		subscriptions.add(token.onCancellationRequested(() => agent.stop()));
		subscriptions.add(agent.onDidChangeTasks(tasks => {
			this.todos.setTodos(request.sessionResource, tasks.flatMap((task, index) => task.status === 'deleted' ? [] : [{
				id: index + 1,
				title: task.subject,
				status: task.status === 'completed' ? 'completed' : task.status === 'in_progress' ? 'in-progress' : 'not-started',
			}]));
		}));
		subscriptions.add(agent.onDidRequestCommandApproval(async command => {
			const allowed = await tools.approve(command, token);
			agent.respondToCommandApproval(command.requestId, allowed);
		}));
		subscriptions.add(agent.onDidEnterPlanMode(async ({ content }) => {
			progress([{ kind: 'markdownContent', content: new MarkdownString('## ' + localize('studio.plan', '实施计划') + '\n\n' + content) }]);
			const choice = await this.quickInputService.pick([
				{ label: localize('studio.planAccept', '批准计划并开始执行'), approved: true },
				{ label: localize('studio.planReject', '拒绝计划'), approved: false },
			], { title: localize('studio.planTitle', '审查实施计划') }, token);
			if (!subscriptions.isDisposed && !token.isCancellationRequested) { agent.approvePlan(choice?.approved === true); }
		}));
		subscriptions.add(agent.onDidAskQuestion(async question => {
			const answer = await this.ask(question, token);
			if (!subscriptions.isDisposed && !token.isCancellationRequested) { agent.answerQuestion(answer); }
		}));

		try {
			const sessionId = request.sessionResource.toString();
			const turns = history.filter(entry => entry.request.sessionResource.toString() === sessionId).map(entry => ({
				requestId: entry.request.requestId,
				userMessage: entry.request.message,
				assistantMessage: entry.response.map(part => part.kind === 'markdownContent' ? part.content.value : '').filter(Boolean).join('\n'),
			}));
			await agent.run(instruction, { history: turns, sessionId, requestId: request.requestId, sourceUserMessage: request.message, images: attachments.images, externalTools });
			if (token.isCancellationRequested) { return {}; }
			this.reportChanges(request, progress);
			return errorMessage ? { errorDetails: { message: errorMessage } } : {};
		} catch (err) {
			return token.isCancellationRequested ? {} : { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
		} finally {
			subscriptions.dispose();
		}
	}

	private async ask(question: AskUserQuestionInput, token: CancellationToken): Promise<string> {
		const picks = question.options.map(option => ({ ...option, custom: false }));
		const options = { title: question.header || question.question, placeHolder: question.question };
		const cancelled = localize('studio.answerCancelled', '用户取消了回答');
		if (question.multiSelect) {
			const answers = await this.quickInputService.pick(picks, { ...options, canPickMany: true }, token);
			return answers?.map(item => item.label).join(', ') || cancelled;
		}
		picks.push({ label: localize('studio.customAnswer', '输入其他回答…'), description: '', custom: true });
		const picked = await this.quickInputService.pick(picks, options, token);
		if (!picked?.custom) { return picked?.label ?? cancelled; }
		return await this.quickInputService.input({ title: question.question }, token) ?? cancelled;
	}

	private reportChanges(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void): void {
		const files = new Map<string, { added: number; removed: number }>();
		for (const group of this.diffStore.groups) {
			if (group.sessionId !== request.sessionResource.toString() || group.chatMessageId !== request.requestId) { continue; }
			for (const hunk of group.hunks) {
				if (hunk.status !== 'applied') { continue; }
				const stats = files.get(hunk.filePath) ?? { added: 0, removed: 0 };
				stats.added += hunk.modifiedText ? hunk.modifiedText.split('\n').length : 0;
				stats.removed += hunk.originalText ? hunk.originalText.split('\n').length : 0;
				files.set(hunk.filePath, stats);
			}
		}
		if (files.size) {
			progress([{
				kind: 'multiDiffData', collapsed: false, multiDiffData: {
					title: localize('studio.edits', '已修改 {0} 个文件', files.size),
					resources: Array.from(files, ([path, stats]) => ({ modifiedUri: URI.file(path), goToFileUri: URI.file(path), ...stats })),
				}
			}]);
		}
	}
}

registerWorkbenchContribution2(AIStudioChatAgentContribution.ID, AIStudioChatAgentContribution, WorkbenchPhase.BlockRestore);
