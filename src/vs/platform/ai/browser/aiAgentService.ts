/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Service
 *  Agent lifecycle state machine + autonomous tool-execution loop.
 *  This is the canonical agent implementation, shared by the Chat panel,
 *  the status bar, and any future surface.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { env } from '../../../base/common/process.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IMarkerService } from '../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ExpectedError } from '../../../base/common/errors.js';
import { localize } from '../../../nls.js';
import { IAIModelService } from './aiModelService.js';
import { IAIIndexService } from './aiIndexService.js';
import { IAIContextService } from './aiContextService.js';
import { ConversationMemory } from '../common/conversationMemory.js';
import { ToolExecutor } from './toolExecutor.js';
import { MemoryStore } from '../common/memoryStore.js';
import { IDiffStore } from '../../../workbench/contrib/aiDiffApply/browser/diffStore.js';
import { getBuiltInTools } from '../common/aiTools.js';
import { ITaskManager } from '../common/taskManager.js';
import { ISubAgentManager } from '../common/subAgentManager.js';
import { allowedInPlan, assistantToolMessage, collectAgentTurn, executeToolBatch, toolResult, validateToolCall, type AgentToolCall, type AgentTurn, type ToolOutcome } from '../common/toolRuntime.js';
import { IUserMemoryStore } from '../common/userMemoryStore.js';
import { getAgentTools } from '../common/agentTools.js';
import type {
	AITool, AgentStep, AgentStatus, AIMessage, AIMessageContent, AIRequestOptions,
	AgentSession, Task, AskUserQuestionInput,
} from '../common/aiTypes.js';

export const IAIAgentService = createDecorator<IAIAgentService>('aiAgentService');

export interface AgentRunOptions {
	sessionId?: string;
	requestId?: string;
	history?: readonly { userMessage: string; assistantMessage: string }[];
}

export interface CommandApprovalRequest {
	requestId: string;
	toolCallId: string;
	command: string;
	cwd: string;
}

export interface IAIAgentService {
	readonly _serviceBrand: undefined;
	readonly status: AgentStatus;
	readonly sessionId?: string;
	readonly isRunning: boolean;
	readonly onDidRequestCommandApproval: Event<CommandApprovalRequest>;
	respondToCommandApproval(requestId: string, approved: boolean): void;
	readonly onDidChangeStatus: Event<AgentStatus>;
	readonly onDidAddStep: Event<AgentStep>;
	readonly onDidChangeTasks: Event<Task[]>;
	readonly steps: readonly AgentStep[];
	readonly tasks: readonly Task[];
	readonly onDidAskQuestion: Event<AskUserQuestionInput & { requestId: string }>;
	readonly onDidEnterPlanMode: Event<{ planFile: string; content: string; requestId: string }>;
	maxSteps: number;
	run(instruction: string, options?: AgentRunOptions): Promise<void>;
	answerQuestion(answer: string, requestId?: string): void;
	approvePlan(approved: boolean, requestId?: string): void;
	stop(): void;
	clearHistory(): void;
	readonly memory: ConversationMemory;
}

export class AIAgentService extends Disposable implements IAIAgentService {
	declare readonly _serviceBrand: undefined;

	private _status: AgentStatus = 'idle';
	private _steps: AgentStep[] = [];
	private _stepCounter = 0;
	private _sessionId?: string;
	get sessionId(): string | undefined { return this._sessionId; }
	get isRunning(): boolean { return this._toolAbortController !== null; }

	private readonly _onDidRequestCommandApproval = this._register(new Emitter<CommandApprovalRequest>());
	readonly onDidRequestCommandApproval = this._onDidRequestCommandApproval.event;
	private readonly _commandApprovals = new Map<string, (approved: boolean) => void>();
	private _toolAbortController: AbortController | null = null;
	private _toolExecutor: ToolExecutor | null = null;
	private _memory: ConversationMemory = new ConversationMemory();
	private _runUsage: { inputTokens: number; outputTokens: number } | null = null;

	private readonly _onDidChangeStatus = this._register(new Emitter<AgentStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onDidAddStep = this._register(new Emitter<AgentStep>());
	readonly onDidAddStep = this._onDidAddStep.event;

	private readonly _onDidChangeTasks = this._register(new Emitter<Task[]>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;

	private readonly _onDidAskQuestion = this._register(new Emitter<AskUserQuestionInput & { requestId: string }>());
	readonly onDidAskQuestion = this._onDidAskQuestion.event;

	private _questionRequestId?: string;
	private _planRequestId?: string;
	private _questionResolve: ((answer: string) => void) | null = null;

	private _planMode: boolean = false;
	private _planApproval: Promise<boolean> | null = null;
	private _planApprovalResolve: ((approved: boolean) => void) | null = null;
	private readonly _onDidEnterPlanMode = this._register(new Emitter<{ planFile: string; content: string; requestId: string }>());
	readonly onDidEnterPlanMode = this._onDidEnterPlanMode.event;

	maxSteps = 20;

	constructor(
		@IAIModelService private readonly aiModelService: IAIModelService,
		@IAIIndexService private readonly indexService: IAIIndexService,
		@IAIContextService private readonly contextService: IAIContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		// Phase 2:
		@ITaskManager private readonly taskManager: ITaskManager,
		@ISubAgentManager private readonly subAgentManager: ISubAgentManager,
		@IUserMemoryStore private readonly userMemoryStore: IUserMemoryStore,
	) {
		super();
		this._register(this.taskManager.onDidChange(tasks => this._onDidChangeTasks.fire(tasks)));
	}

	get status(): AgentStatus { return this._status; }
	get steps(): readonly AgentStep[] { return this._steps; }
	get tasks(): readonly Task[] { return this.taskManager?.tasks ?? []; }
	get memory(): ConversationMemory { return this._memory; }

	// --- Public API ---------------------------------------------------------

	async run(instruction: string, turn: AgentRunOptions = {}): Promise<void> {
		if (this._toolAbortController) { return; }
		const startTime = Date.now();
		const cfgMaxSteps = this.configurationService.getValue<number>('ai.agent.maxSteps');
		if (cfgMaxSteps && cfgMaxSteps > 0) { this.maxSteps = cfgMaxSteps; }
		// 0.7: Multi-root workspace — use first folder; fallback to ~/.ai-studio/global/
		const folders = this.workspaceContextService.getWorkspace().folders;
		let root: string;
		if (folders.length > 0) {
			root = folders[0].uri.fsPath;
		} else {
			const home = env.HOME || env.USERPROFILE || '.';
			root = (home + '/.ai-studio/global').replace(/\\/g, '/');
		}
		this.logService.info('[AIAgentService] Workspace root: ' + root);

		const cfgModel = this.configurationService.getValue<string>('ai.modelId');
		const cfgMaxTokens = this.configurationService.getValue<number>('ai.chat.maxTokens');
		const options: AIRequestOptions = {
			model: cfgModel || '', maxTokens: cfgMaxTokens || 16000, temperature: 0,
			thinking: false, cacheSystemPrompt: true, maxContextTokens: 180000,
		};
		const memoryStore = new MemoryStore(root, this.fileService, this.logService);
		const controller = new AbortController();
		this._toolAbortController = controller;
		this._runUsage = null;
		this._planMode = false;
		this._planApproval = null;
		const switched = this._sessionId !== turn.sessionId;
		this._sessionId = turn.sessionId;
		if (switched) { this.taskManager.clear(); }
		this.clearHistory();
		this._setStatus('running');
		try {
			try {
				await this._runSteps(instruction, root, memoryStore, options, controller.signal, turn, switched);
			} catch (err) {
				if (!controller.signal.aborted) {
					this.logService.error('[AIAgentService] Run failed:', err);
					this._addStep('error', err instanceof Error ? err.message : String(err));
					this._setStatus('error');
				}
			}
			if (controller.signal.aborted && !this._steps.length) { return; }
			const agentSession: AgentSession = {
				sessionId: new Date(startTime).toISOString().replace(/[:.]/g, '-') + '-' + generateUuid(),
				startedAt: startTime,
				chatSessionId: turn.sessionId,
				endedAt: Date.now(),
				instruction,
				steps: [...this._steps],
				taskSnapshot: this.taskManager?.tasks ?? null,
				turns: [...this._memory.turns],
				status: this._status,
				usage: this._runUsage,
				meta: {
					modelId: options.model || '',
					maxSteps: this.maxSteps,
					maxTokens: options.maxTokens || 0,
				},
			};
			await memoryStore.saveSessionFull(agentSession);
		} finally {
			this._toolExecutor = null;
			this._toolAbortController = null;
		}
	}

	private async _runSteps(instruction: string, root: string, memoryStore: MemoryStore, options: AIRequestOptions, signal: AbortSignal, turn: AgentRunOptions, switched: boolean): Promise<void> {
		const previous = turn.sessionId
			? (switched || !turn.history ? await memoryStore.loadLatestForChat(turn.sessionId) : undefined)
			: (turn.history ? undefined : await memoryStore.loadLastSession());
		if (signal.aborted) { return; }
		if (switched && previous?.taskSnapshot) { this.taskManager.restore(previous.taskSnapshot); }
		for (const t of turn.history ?? previous?.turns ?? []) {
			this._memory.addTurn(t.userMessage, t.assistantMessage);
		}

		if (signal.aborted) { return; }

		// 0.3: Reuse a single ToolExecutor for the entire agent run
		this._toolExecutor = new ToolExecutor(
			this.fileService, this.logService, this.diffStore,
			this.indexService, this.markerService, this.workspaceContextService,
			this.configurationService, signal,
			this.taskManager, this.subAgentManager, this.userMemoryStore,
			// Phase 3: AskUserQuestion callback
			(qInput: AskUserQuestionInput) => {
				if (!this._onDidAskQuestion.hasListeners()) { throw new Error('No user interface is available for questions.'); }
				return new Promise<string>((resolve) => {
					this._questionResolve = resolve;
					this._questionRequestId = generateUuid();
					this._onDidAskQuestion.fire({ ...qInput, requestId: this._questionRequestId });
				});
			},
			// Phase 3: EnterPlanMode callback
			() => { this._planMode = true; },
			// Phase 3: ExitPlanMode callback
			(planFile: string, content: string) => {
				this._addStep('plan', content);
				const requestId = this._planRequestId = generateUuid();
				this._planApproval = new Promise(resolve => { this._planApprovalResolve = resolve; });
				this._setStatus('waiting_for_approval');
				if (this._onDidEnterPlanMode.hasListeners()) { this._onDidEnterPlanMode.fire({ planFile, content, requestId }); }
				else { queueMicrotask(() => this.approvePlan(false, requestId)); }
			},
			undefined, turn,
		);

		this._addStep('thought', instruction);

		const messages = await this.contextService.buildContext({
			instruction,
			memory: this._memory,
			topK: 5,
		});
		if (signal.aborted) { return; }
		// Inject relevant code from index
		if (this.indexService?.isReady) {
			try {
				const snippets = await this.indexService.search(instruction, 5);
				if (snippets.length) {
					let codeBlock = '\n\n## Relevant Code\n\n';
					for (const s of snippets) {
						const ext = (s.filePath.split('.').pop() || '');
						codeBlock += '```' + ext + ':' + s.filePath + ':' + s.startLine + '\n' + s.content + '\n```\n\n';
					}
					const firstMsg = messages[0];
					if (typeof firstMsg.content === 'string') {
						firstMsg.content += codeBlock;
					}
				}
			} catch { /* index unavailable */ }
		}

		const MAX_BACKOFF_MS = 30_000;
		const BASE_BACKOFF_MS = 500;
		let step = 0;
		let consecutiveErrors = 0;

		while (step < this.maxSteps && !signal.aborted && this._status === 'running') {
			// Recompute tools each iteration so plan-mode restrictions take effect immediately
			const tools = [...getBuiltInTools(), ...getAgentTools()].filter(t => !this._planMode || allowedInPlan(t.name));
			step++;
			let result: AgentTurn;
			try {
				result = await this._streamToCompletion(messages, tools, options, signal);
			} catch (err) {
				if (signal.aborted) { return; }
				consecutiveErrors++;
				const isRetryable = _isRetryableError(err);
				this.logService.error('[AIAgentService] stream error (retryable=' + isRetryable + '):', err);

				if (!isRetryable || consecutiveErrors >= 5) {
					this._addStep('error', '任务已停止。' + describeModelError(err)
						+ (consecutiveErrors >= 5 ? '（已达到重试上限）' : ''));
					this._setStatus('error');
					return;
				}

				const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
				this._addStep('thought', '请求失败，' + (backoffMs / 1000).toFixed(1) + ' 秒后重试（' + consecutiveErrors + '/5）。');
				if (signal.aborted) { return; }
				const delay = timeout(backoffMs);
				const cancelDelay = () => delay.cancel();
				signal.addEventListener('abort', cancelDelay, { once: true });
				try { await delay; } finally { signal.removeEventListener('abort', cancelDelay); }
				continue;
			}

			if (this._status !== 'running') { break; }
			consecutiveErrors = 0;

			if (!result.calls.length) {
				// Emit the model's text response so it shows in the chat
				if (result.text && result.text.trim()) {
					this._addStep('thought', result.text.trim());
				} else {
					// Empty response — show an actionable error message
					this.logService.warn('[AIAgentService] Empty response from model — check apiType, endpoint, and model ID.');
					this._addStep('thought', '模型返回了空回复。请检查模型设置中的接口类型、服务地址、模型 ID 和 API 密钥。当前模型为 ' + (this.aiModelService.currentModelId || '(未设置)') + '，接口类型为 ' + this.aiModelService.currentProviderId);
				}
				this._memory.addTurn(instruction, result.text);
				this._setStatus('stopped');
				break;
			}

			if (result.text.trim()) { this._addStep('thought', result.text.trim()); }
			messages.push(assistantToolMessage(result));
			// Check both the advertised set and current mode. A sibling call can enter plan mode.
			let planPresented = false;
			const blocks = await executeToolBatch(result.calls, async call => {
				const definition = tools.find(t => t.name === call.name);
				const invalid = definition && validateToolCall(call, definition);
				let blocked = definition ? undefined : 'Tool was not offered for this turn.';
				if (planPresented) { blocked = 'Wait for a new model turn after plan review.'; }
				if (this._planMode && !allowedInPlan(call.name)) { blocked = 'Tool is unavailable during read-only planning.'; }
				if (!this._planMode && call.name === 'ExitPlanMode') { blocked = 'Enter plan mode before submitting a plan.'; }
				const block = await this._executeTool(call, root, signal, blocked, invalid);
				if (this._planApproval) { planPresented = true; }
				return block;
			}, signal);
			messages.push({ role: 'tool', content: blocks });

			// Compress conversation if approaching context limit
			if (this._memory.estimatedTokens > (options.maxContextTokens || 180000) * 0.8) {
				await this._memory.compactWithSummarizer(
					async (turns) => {
						const summaryPrompt: AIMessage = {
							role: 'user',
							content: 'Summarize the following conversation turns concisely. Focus on what was accomplished, what files were changed, and what remains to be done. Keep it under 500 words.\n\n' +
								turns.map(t => 'User: ' + t.userMessage.slice(0, 300) + '\nAssistant: ' + t.assistantMessage.slice(0, 300)).join('\n\n'),
						};
						const summaryMessages = [messages[0], summaryPrompt];
						const summaryResult = await this._streamToCompletion(summaryMessages, [], {
							...options, maxTokens: 1024, temperature: 0,
						}, signal);
						return summaryResult.text || 'Prior work completed.';
					},
					options.maxContextTokens || 180000,
					0.8,
				);
			}
			// Phase 3: Pause for plan approval — wait inline so listeners stay alive
			if (this._planApproval) {
				const approved = await this._planApproval;
				this._planApproval = null;
				this._planApprovalResolve = null;
				if (signal.aborted) { return; }
				if (approved) {
					this._planMode = false;
					this._setStatus('running');
					messages.push({
						role: 'user',
						content: 'The user has approved your implementation plan. Proceed with the implementation using the full tool set.',
					});
					continue;
				} else {
					this._planMode = false;
					this._setStatus('stopped');
					this._addStep('thought', '用户已拒绝计划。');
					break;
				}
			}
			continue;
		}

		if (step >= this.maxSteps && this._status === 'running' && !signal.aborted) {
			this._addStep('thought', '已达到本次任务的步数上限（' + this.maxSteps + '）。');
		}
		if ((this._status as string) === 'running') {
			this._setStatus('stopped');
		}
	}

	stop(): void {
		this._setStatus('stopped');
		this._toolAbortController?.abort();
		this.answerQuestion('');
		// Resolve pending plan approval promise to unblock run()
		if (this._planApprovalResolve) {
			this._planApprovalResolve(false);
			this._planApprovalResolve = null;
		}
	}

	clearHistory(): void { this._steps = []; this._stepCounter = 0; this._memory.clear(); }

	answerQuestion(answer: string, requestId?: string): void {
		if (this._questionResolve && (!requestId || requestId === this._questionRequestId)) {
			this._questionResolve(answer);
			this._questionResolve = null;
			this._questionRequestId = undefined;
		}
	}

	approvePlan(approved: boolean, requestId?: string): void {
		if (this._planApprovalResolve && (!requestId || requestId === this._planRequestId)) {
			this._planRequestId = undefined;
			this._planApprovalResolve(approved);
			this._planApprovalResolve = null;
		}
	}

	// --- Internal ------------------------------------------------------------

	private _setStatus(s: AgentStatus) { this._status = s; this._onDidChangeStatus.fire(s); }

	private _addStep(type: AgentStep['type'], content: string, call?: AgentToolCall, outcome?: ToolOutcome) {
		const step: AgentStep = {
			stepNumber: ++this._stepCounter, type, content, toolName: call?.name, toolInput: type === 'tool_use' ? call?.input : undefined, toolCallId: call?.id, outcome, isError: outcome && outcome !== 'success', timestamp: Date.now(),
		};
		this._steps.push(step);
		this._onDidAddStep.fire(step);
	}

	private _streamToCompletion(messages: AIMessage[], tools: AITool[], options: AIRequestOptions, signal: AbortSignal): Promise<AgentTurn> {
		return collectAgentTurn(this.aiModelService, messages, tools, options, signal, usage => {
			this._runUsage = {
				inputTokens: (this._runUsage?.inputTokens ?? 0) + usage.inputTokens,
				outputTokens: (this._runUsage?.outputTokens ?? 0) + usage.outputTokens,
			};
		});
	}

	private async _executeTool(call: AgentToolCall, root: string, signal: AbortSignal, blocked?: string, invalid?: string): Promise<AIMessageContent> {
		this._addStep('tool_use', call.name, call);
		const images: AIMessageContent[] = [];
		const result = blocked ? { text: 'Error: ' + blocked, outcome: 'denied' as const }
			: invalid ? { text: invalid, outcome: 'error' as const }
				: await this._toolExecutor!.executeCall(call.name, call.input,
					source => images.push({ type: 'image', source }), (command, cwd, childSignal) => this._requestCommandApproval(call.id, command, cwd, childSignal ?? signal));
		if ((call.name === 'edit_file' || call.name === 'write_file') && result.outcome === 'success') {
			try { await this.indexService.indexFile(call.input.path as string); }
			catch (error) { this.logService.warn('[AIAgentService] Incremental indexing failed:', error); }
		}

		let text = result.text;
		if (text.length > 2000 && !signal.aborted) {
			const path = '.ai-studio/tool-outputs/' + generateUuid() + '.txt';
			try {
				await this.fileService.createFolder(URI.file(root + '/.ai-studio/tool-outputs'));
				await this.fileService.writeFile(URI.file(root + '/' + path), VSBuffer.fromString(text));
				text = text.slice(0, 1600) + '\n[Full output: ' + path + ']';
			} catch { /* If archiving fails, retain the output. */ }
		}
		this._addStep('tool_result', text, call, result.outcome);
		return toolResult(call.id, text, result.outcome, images);
	}

	private async _requestCommandApproval(toolCallId: string, command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted || !this._onDidRequestCommandApproval.hasListeners()) { return false; }
		const requestId = generateUuid();
		const cancel = () => this.respondToCommandApproval(requestId, false);
		try {
			return await new Promise<boolean>(resolve => {
				this._commandApprovals.set(requestId, resolve);
				signal.addEventListener('abort', cancel, { once: true });
				this._setStatus('waiting_for_approval');
				if (!signal.aborted) { this._onDidRequestCommandApproval.fire({ requestId, toolCallId, command, cwd }); }
			});
		} finally {
			this._commandApprovals.delete(requestId);
			signal.removeEventListener('abort', cancel);
			if (!this._toolAbortController?.signal.aborted && !this._commandApprovals.size) { this._setStatus('running'); }
		}
	}

	respondToCommandApproval(requestId: string, approved: boolean): void {
		this._commandApprovals.get(requestId)?.(approved);
	}


}

function describeModelError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const status = /^(?:API|Anthropic) (\d{3})\b/.exec(message)?.[1];
	switch (status) {
		case '401': return localize('studio.model.unauthorized', '模型服务无法验证密钥（HTTP 401）。请在「模型设置」中更新 API 密钥。');
		case '403': return localize('studio.model.forbidden', '模型服务拒绝了请求（HTTP 403）。请检查密钥的访问权限。');
		case '404': return localize('studio.model.notFound', '模型或服务地址不存在（HTTP 404）。请检查模型 ID 和服务地址。');
		case '429': return localize('studio.model.rateLimited', '模型服务已达到请求限额（HTTP 429）。请稍后再试或检查服务配额。');
	}
	if (status) {
		return localize('studio.model.httpError', '模型服务返回错误（HTTP {0}）。请检查模型设置，详情见窗口日志。', status);
	}
	if (message === 'Failed to fetch' || message === 'fetch failed') {
		return localize('studio.model.networkError', '无法连接模型服务。请检查服务地址、网络连接和系统代理。');
	}
	return message;
}

function _isRetryableError(err: unknown): boolean {
	if (!err) { return true; }
	if (err instanceof ExpectedError || (err instanceof Error && err.name === 'AbortError')) { return false; }
	if (err instanceof Error && err.name === 'TimeoutError') { return true; }
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) { return true; }
	if (msg.includes('503') || msg.includes('502') || msg.includes('504')) { return true; }
	if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound')) { return true; }
	if (msg.includes('timeout') || msg.includes('timed out')) { return true; }
	if (msg.includes('socket') || msg.includes('network')) { return true; }
	if (msg.includes('overloaded') || msg.includes('capacity')) { return true; }
	// Non-retryable: authentication, authorization, bad request
	if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) { return false; }
	if (msg.includes('invalid') && msg.includes('api key')) { return false; }
	if (msg.includes('400') || msg.includes('bad request') || msg.includes('invalid_request_error')) { return false; }
	return true;
}
