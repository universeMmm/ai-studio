/*---------------------------------------------------------------------------------------------
 *  AI Studio - Agent Service
 *  Agent lifecycle state machine + autonomous tool-execution loop.
 *  This is the canonical agent implementation, shared by the Chat panel,
 *  the status bar, and any future surface.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import { VSBuffer } from "../../../base/common/buffer.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import { IFileService } from "../../../platform/files/common/files.js";
import { IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { IMarkerService } from "../../../platform/markers/common/markers.js";
import { IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { IAIModelService } from "./aiModelService.js";
import { IAIIndexService } from "./aiIndexService.js";
import { IAIContextService } from "./aiContextService.js";
import { ConversationMemory } from "../common/conversationMemory.js";
import { ToolExecutor } from "./toolExecutor.js";
import { MemoryStore } from '../common/memoryStore.js';
import { IDiffStore } from "../../../workbench/contrib/aiDiffApply/browser/diffStore.js";
import { getBuiltInTools } from "../common/aiTools.js";
import { ITaskManager } from "../common/taskManager.js";
import { ISubAgentManager } from "../common/subAgentManager.js";
import { getAgentTools } from "../common/agentTools.js";
import type {
	AITool, AgentStep, AgentStatus, AIMessage, AIRequestOptions, AIStreamCallbacks,
	AgentSession, Task,
} from "../common/aiTypes.js";

export const IAIAgentService = createDecorator<IAIAgentService>("aiAgentService");

export interface IAIAgentService {
	readonly _serviceBrand: undefined;
	readonly status: AgentStatus;
	readonly onDidChangeStatus: Event<AgentStatus>;
	readonly onDidAddStep: Event<AgentStep>;
	readonly onDidChangeTasks: Event<Task[]>;
	readonly steps: readonly AgentStep[];
	readonly tasks: readonly Task[];
	maxSteps: number;
	run(instruction: string): Promise<void>;
	stop(): void;
	clearHistory(): void;
	readonly memory: ConversationMemory;
}

export class AIAgentService extends Disposable implements IAIAgentService {
	declare readonly _serviceBrand: undefined;

	private _status: AgentStatus = "idle";
	private _steps: AgentStep[] = [];
	private _stepCounter = 0;
	private _abortController: AbortController | null = null;
	private _toolAbortController: AbortController | null = null;
	private _toolExecutor: ToolExecutor | null = null;
	private _memory: ConversationMemory = new ConversationMemory();
	private _lastUsage: { inputTokens: number; outputTokens: number } | null = null;

	private readonly _onDidChangeStatus = this._register(new Emitter<AgentStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onDidAddStep = this._register(new Emitter<AgentStep>());
	readonly onDidAddStep = this._onDidAddStep.event;

	private readonly _onDidChangeTasks = this._register(new Emitter<Task[]>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;

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
	) { super(); }

	get status(): AgentStatus { return this._status; }
	get steps(): readonly AgentStep[] { return this._steps; }
	get tasks(): readonly Task[] { return this.taskManager?.tasks ?? []; }
	get memory(): ConversationMemory { return this._memory; }

	// --- Public API ---------------------------------------------------------

	async run(instruction: string): Promise<void> {
		if ((this._status as string) === "running") { return; }
		this.clearHistory();
		this._setStatus("running");
		const startTime = Date.now();
		const cfgMaxSteps = this.configurationService.getValue<number>('ai.agent.maxSteps');
		if (cfgMaxSteps && cfgMaxSteps > 0) { this.maxSteps = cfgMaxSteps; }
		// 0.7: Multi-root workspace — use first folder; fallback to ~/.ai-studio/global/
		const folders = this.workspaceContextService.getWorkspace().folders;
		let root: string;
		if (folders.length > 0) {
			root = folders[0].uri.fsPath;
		} else {
			const home = process.env.HOME || process.env.USERPROFILE || '.';
			root = (home + '/.ai-studio/global').replace(/\\/g, '/');
		}
		this.logService.info("[AIAgentService] Workspace root: " + root);

		// 0.2: Create tool-level abort controller for this run
		this._toolAbortController = new AbortController();

		const memoryStore = new MemoryStore(root, this.fileService, this.logService);
		const prevSession = await memoryStore.loadLastSession();
		if (prevSession?.turns.length) {
			for (const t of prevSession.turns) {
				this._memory.addTurn(t.userMessage, t.assistantMessage);
			}
		}

		// 0.3: Reuse a single ToolExecutor for the entire agent run
		this._toolExecutor = new ToolExecutor(
			this.fileService, this.logService, this.diffStore,
			this.indexService, this.markerService, this.workspaceContextService,
			this.configurationService, this._toolAbortController.signal,
			this.taskManager, this.subAgentManager, undefined,
		);

		this._addStep("thought", instruction);

		const messages = await this.contextService.buildContext({
			instruction,
			memory: this._memory,
			topK: 5,
		});
		// Inject relevant code from index
		if (this.indexService?.isReady) {
			try {
				const snippets = await this.indexService.search(instruction, 5);
				if (snippets.length) {
					let codeBlock = "\n\n## Relevant Code\n\n";
					for (const s of snippets) {
						const ext = (s.filePath.split(".").pop() || "");
						codeBlock += "```" + ext + ":" + s.filePath + ":" + s.startLine + "\n" + s.content + "\n```\n\n";
					}
					const firstMsg = messages[0];
					if (typeof firstMsg.content === 'string') {
						firstMsg.content += codeBlock;
					}
				}
			} catch { /* index unavailable */ }
		}
		const tools: AITool[] = [...getBuiltInTools(), ...getAgentTools()];
		const cfgModel = this.configurationService.getValue<string>("ai.modelId");
		const cfgMaxTokens = this.configurationService.getValue<number>("ai.chat.maxTokens");
		const options: AIRequestOptions = {
			model: cfgModel || "", maxTokens: cfgMaxTokens || 16000, temperature: 0,
			thinking: false, cacheSystemPrompt: true, maxContextTokens: 180000,
		};

		try {

		const MAX_BACKOFF_MS = 30_000;
		const BASE_BACKOFF_MS = 500;
		let step = 0;
		let consecutiveErrors = 0;

		while (step < this.maxSteps && (this._status as string) === "running") {
			step++;

			let result: { type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; toolCallId?: string };
			try {
				result = await this._streamToCompletion(messages, tools, options);
			} catch (err: any) {
				consecutiveErrors++;
				const isRetryable = _isRetryableError(err);
				this.logService.error("[AIAgentService] stream error (retryable=" + isRetryable + "):", err);

				if (!isRetryable || consecutiveErrors >= 5) {
					this._addStep("error", "Agent stopped: " + (err?.message || String(err))
						+ (consecutiveErrors >= 5 ? " (max retries)" : " (non-retryable)"));
					this._setStatus("error");
					return;
				}

				const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
				this._addStep("thought", "Error, retrying in " + (backoffMs / 1000).toFixed(1) + "s (attempt " + consecutiveErrors + "/5)...");
				await new Promise(r => setTimeout(r, backoffMs));
				continue;
			}

			if (this._status !== "running") { break; }
			consecutiveErrors = 0;

			if (result.type === "end_turn") {
				// Emit the model's text response so it shows in the chat
				if (result.text && result.text.trim()) {
					this._addStep("thought", result.text.trim());
				} else {
					// Empty response — show an actionable error message
					this.logService.warn('[AIAgentService] Empty response from model — check apiType, endpoint, and model ID.');
					this._addStep("thought", "**收到空响应** — 请检查模型配置：API 类型、端点 URL、模型 ID 和 API Key 是否正确？当前模型: " + (this.aiModelService.currentModelId || '(未设置)') + "，API 类型: " + this.aiModelService.currentProviderId);
				}
				this._memory.addTurn(instruction, result.text || "Task completed.");
				break;
			}

			if (result.type === "tool_use") {
				// Emit text the model produced before issuing the tool call
				if (result.text && result.text.trim()) {
					this._addStep("thought", result.text.trim());
				}
				this._addStep("tool_use", "Calling " + result.toolName!, result.toolName!, result.toolInput);

				const prevGroupCount = this.diffStore.groups.length;
				const executor = this._toolExecutor!;
				const isEditing = result.toolName === "edit_file" || result.toolName === "write_file";
				const filePath = isEditing ? (result.toolInput?.path as string) : undefined;

				// 0.4: Snapshot before editing tools
				if (isEditing && filePath) {
					await executor.createSnapshot([filePath]);
				}

				const toolResult = await executor.execute(result.toolName!, result.toolInput!);

				// 0.4: Commit or rollback based on result
				if (isEditing) {
					if (toolResult.startsWith("Error")) {
						await executor.rollbackAll();
					} else {
						executor.commitSnapshot();
						// 0.6: Update index after file modification
						if (filePath) {
							await this.indexService?.indexFile(filePath);
						}
					}
				}

				let displayResult = toolResult;
				if (toolResult.length > 2000) {
					const spillDir = root + '/.ai-studio/tool-outputs';
					const spillName = result.toolName + '_' + Date.now() + '.txt';
					try {
						await this.fileService.createFolder(URI.file(spillDir));
						await this.fileService.writeFile(URI.file(spillDir + '/' + spillName), VSBuffer.fromString(toolResult));
						displayResult = '[Large output (' + toolResult.length + ' chars) written to .ai-studio/tool-outputs/' + spillName + ']';
					} catch { /* keep in-memory if spill fails */ }
				}
				this._addStep("tool_result", displayResult);

				// Track diffs from edit/write tools and emit them as readable steps
				if (result.toolName === "edit_file" || result.toolName === "write_file") {
					const newGroups = this.diffStore.groups.slice(prevGroupCount);
					for (const g of newGroups) {
						for (const h of g.hunks) {
							let md = "### Edited: " + h.filePath + "\n```diff\n";
							if (h.originalText) md += h.originalText.split("\n").map((l: string) => "- " + l).join("\n") + "\n";
							if (h.modifiedText) md += h.modifiedText.split("\n").map((l: string) => "+ " + l).join("\n") + "\n";
							md += "```";
							this._addStep("tool_result", md);
						}
					}
				}

				messages.push({
					role: "assistant",
					content: [{ type: "tool_use", id: result.toolCallId!, name: result.toolName!, input: result.toolInput! }],
				});
				messages.push({
					role: "tool",
					content: [{ type: "tool_result", tool_use_id: result.toolCallId!, content: displayResult, is_error: toolResult.startsWith("Error") }],
				});

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
							});
							return summaryResult.text || 'Prior work completed.';
						},
						options.maxContextTokens || 180000,
						0.8,
					);
				}
				continue;
			}

			if (result.type === "error") {
				this._addStep("error", result.text || "Unknown error");
				this._setStatus("error");
				return;
			}
		}

		if (step >= this.maxSteps) {
			this._addStep("thought", "Reached max steps (" + String(this.maxSteps) + "). Stopped.");
		}
		if ((this._status as string) === "running") {
			this._setStatus("stopped");
		}
		const agentSession: AgentSession = {
			sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
			startedAt: startTime,
			endedAt: Date.now(),
			instruction,
			steps: [...this._steps],
			taskSnapshot: this.taskManager?.tasks ?? null,
			turns: [...this._memory.turns],
			status: this._status,
			usage: this._lastUsage,
			meta: {
				modelId: options.model || '',
				maxSteps: this.maxSteps,
				maxTokens: options.maxTokens || 0,
			},
		};
		try { await memoryStore.saveSessionFull(agentSession); } catch { /* best-effort */ }
		} finally {
			// 0.3: Clean up per-run resources
			this._toolExecutor = null;
			this._toolAbortController = null;
		}
	}

	stop(): void {
		this._setStatus("stopped");
		this._abortController?.abort();
		this._abortController = null;
		// 0.2: Propagate cancellation to in-flight tool executions
		this._toolAbortController?.abort();
		this._toolAbortController = null;
	}

	clearHistory(): void { this._steps = []; this._stepCounter = 0; this._memory.clear(); }

	// --- Internal ------------------------------------------------------------

	private _setStatus(s: AgentStatus) { this._status = s; this._onDidChangeStatus.fire(s); }

	private _addStep(type: AgentStep["type"], content: string, toolName?: string, toolInput?: Record<string, unknown>) {
		const step: AgentStep = {
			stepNumber: ++this._stepCounter, type, content, toolName, toolInput, timestamp: Date.now(),
		};
		this._steps.push(step);
		this._onDidAddStep.fire(step);
	}

	private _streamToCompletion(
		messages: AIMessage[], tools: AITool[], options: AIRequestOptions,
	): Promise<{ type: "end_turn" | "tool_use" | "error"; text?: string; toolName?: string; toolInput?: Record<string, unknown>; toolCallId?: string }> {
		return new Promise((resolve, reject) => {
			let text = "", resolved = false;
			let tName = "", tInput: Record<string, unknown> = {}, tId = "";

			const cb: AIStreamCallbacks = {
				onToken: (t: string) => { text += t; },
				onToolUse: (name, input, callId) => { tName = name; tInput = input; tId = callId; },
				onToolResult: () => { },
				onError: (err) => { if (!resolved) { resolved = true; reject(err); } },
				onDone: (reason) => {
					if (!resolved) {
						resolved = true;
						if (reason === "tool_use" || tName) {
							resolve({ type: "tool_use", text, toolName: tName, toolInput: tInput, toolCallId: tId });
						} else {
							resolve({ type: "end_turn", text });
						}
					}
				},
				onUsage: (usage) => {
					this._lastUsage = usage;
					this.logService.info(`[AIAgentService] Token usage: in=${usage.inputTokens}, out=${usage.outputTokens}`);
				},
			};
			// 0.1: Caller ensures serial execution (plan awaited before main loop) — no abort needed
			this._abortController = this.aiModelService.streamChat(messages, tools, options, cb);
		});
	}


}

function _isRetryableError(err: any): boolean {
	if (!err) return true;
	if (err.name === "AbortError") return false;
	if (err.name === "TimeoutError") return true;
	const msg = (err.message || String(err)).toLowerCase();
	if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return true;
	if (msg.includes("503") || msg.includes("502") || msg.includes("504")) return true;
	if (msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("enotfound")) return true;
	if (msg.includes("timeout") || msg.includes("timed out")) return true;
	if (msg.includes("socket") || msg.includes("network")) return true;
	if (msg.includes("overloaded") || msg.includes("capacity")) return true;
	// Non-retryable: authentication, authorization, bad request
	if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) return false;
	if (msg.includes("invalid") && msg.includes("api key")) return false;
	if (msg.includes("400") || msg.includes("bad request") || msg.includes("invalid_request_error")) return false;
	return true;
}
