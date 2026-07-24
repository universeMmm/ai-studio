/*---------------------------------------------------------------------------------------------
 *  AI Studio — Sub-Agent Manager
 *  Manages sub-agent lifecycle: creation, parallel execution, result aggregation.
 *  Also handles SendMessage routing between agents (merged from agentCommunicator).
 *
 *  Sub-agents run in-process: each is a mini agent loop with its own
 *  ConversationMemory, restricted tool set, and independent system prompt.
 *  Multiple sub-agents can execute in parallel via Promise.all().
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import type { AIMessage, AITool, AIRequestOptions, AIStreamCallbacks } from './aiTypes.js';
import type { SubAgentConfig, SubAgentResult } from './aiTypes.js';
import { ConversationMemory } from './conversationMemory.js';

// IAIModelService is imported from browser/ — this is intentional as common/ modules can reference browser/ types
import { IAIModelService } from '../browser/aiModelService.js';
import { IAIIndexService } from '../browser/aiIndexService.js';
// ToolExecutor is imported from browser/ — needed for worktree isolation
import { IDiffStore } from '../../../workbench/contrib/aiDiffApply/browser/diffStore.js';
import { IMarkerService } from '../../../platform/markers/common/markers.js';

export const ISubAgentManager = createDecorator<ISubAgentManager>('subAgentManager');

export interface ISubAgentManager {
	readonly _serviceBrand: undefined;
	execute(configs: SubAgentConfig[]): Promise<SubAgentResult[]>;
	sendMessage(from: string, to: string, summary: string, message: string | object): void;
	getRunningAgents(): string[];
}

/** Tool sets per sub-agent type */
const TOOL_SETS: Record<string, string[]> = {
	'general-purpose': [], // empty = all tools
	'Explore': ['read_file', 'search_content', 'search_files', 'search_pattern', 'list_directory', 'read_lints', 'web_fetch', 'web_search'],
	'Plan': ['read_file', 'search_content', 'search_files', 'search_pattern', 'list_directory', 'read_lints', 'web_fetch', 'web_search'],
	'verification': ['read_file', 'search_content', 'search_files', 'list_directory', 'run_command', 'read_lints'],
};

/** System prompt prefixes per sub-agent type */
const SYSTEM_PROMPTS: Record<string, string> = {
	'general-purpose': 'You are a sub-agent dispatched to handle a specific task. Focus only on the assigned task. Report completion or ask for help via SendMessage if needed.',
	'Explore': 'You are a read-only explorer agent. Search, read, and analyze code but do NOT modify any files or run any commands. Report your findings concisely.',
	'Plan': 'You are a software architect agent. Explore the codebase and design solutions. Do NOT modify any files or run any commands. Present your design clearly.',
	'verification': 'You are a verification agent. Run builds, tests, and linters to verify implementation correctness. Do NOT edit any files. Output PASS/FAIL/PARTIAL with the evidence from each check. If PASS, re-run 2-3 commands to confirm. Report the verdict.',
};

export class SubAgentManager implements ISubAgentManager {
	declare readonly _serviceBrand: undefined;

	/** Running sub-agents by name — used for SendMessage routing */
	private _running: Map<string, { memory: ConversationMemory; abort: AbortController; worktreePath?: string }> = new Map();

	constructor(
		@IAIModelService private readonly aiModelService: IAIModelService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAIIndexService private readonly indexService: IAIIndexService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IMarkerService private readonly markerService: IMarkerService,
	) {}

	async execute(configs: SubAgentConfig[]): Promise<SubAgentResult[]> {
		// Deduplicate names
		const nameCounts = new Map<string, number>();
		const namedConfigs = configs.map(c => {
			let name = c.name || c.subagent_type;
			const count = nameCounts.get(name) || 0;
			nameCounts.set(name, count + 1);
			if (count > 0) name = name + '-' + (count + 1);
			return { ...c, name };
		});

		// Parallel execution via Promise.all
		const promises = namedConfigs.map(config => this._runSingle(config));
		const settled = await Promise.allSettled(promises);

		const results: SubAgentResult[] = [];
		for (let i = 0; i < settled.length; i++) {
			const s = settled[i];
			const name = namedConfigs[i].name;
			if (s.status === 'fulfilled') {
				results.push(s.value);
			} else {
				results.push({
					name,
					status: 'error',
					text: '',
					error: s.reason?.message || String(s.reason),
					toolCalls: 0,
				});
			}
		}

		return results;
	}

	sendMessage(from: string, to: string, summary: string, message: string | object): void {
		const targets = to === '*'
			? Array.from(this._running.entries()).filter(([name]) => name !== from)
			: [[to, this._running.get(to)] as const].filter(([, v]) => v);

		for (const [targetName, target] of targets) {
			if (!target) continue;

			// Protocol messages
			if (typeof message === 'object' && 'type' in message) {
				const msg = message as { type: string; approve?: boolean; request_id?: string };
				if (msg.type === 'shutdown_response' && msg.approve) {
					target.abort.abort();
					this.logService.info(`[SubAgentManager] ${targetName} shutdown via ${from}`);
					continue;
				}
				// Non-approval protocol messages are injected as user message
				const protocolText = JSON.stringify(message);
				target.memory.addTurn(`[Protocol from ${from}]: ${summary}`, `Received: ${protocolText}`);
			} else {
				// Plain text message — push to ConversationMemory
				const text = typeof message === 'string' ? message : JSON.stringify(message);
				target.memory.addTurn(`[Message from ${from}]: ${summary}`, text);
			}
		}
	}

	getRunningAgents(): string[] {
		return Array.from(this._running.keys());
	}

	// --- Internal ---------------------------------------------------------------

	private async _runSingle(config: SubAgentConfig & { name: string }): Promise<SubAgentResult> {
		const memory = new ConversationMemory();
		const abort = new AbortController();
		this._running.set(config.name, { memory, abort });

		let worktreePath: string | undefined;

		try {
			// Phase 3: git worktree isolation
			if ((config as any).isolation === 'worktree') {
				worktreePath = await this._createWorktree(config.name);
				config.cwd = worktreePath;
			}

			const tools = this._buildToolSet(config.subagent_type);
			let systemPrompt = SYSTEM_PROMPTS[config.subagent_type] || SYSTEM_PROMPTS['general-purpose'];
			if (worktreePath) {
				systemPrompt += `\n\nYour working directory is an isolated git worktree at: ${worktreePath}`;
			}
			const messages: AIMessage[] = [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: 'prompt' in config ? (config as any).prompt : config.description },
			];

			const options: AIRequestOptions = {
				model: '',
				maxTokens: 8000,
				temperature: 0,
				thinking: false,
				cacheSystemPrompt: true,
				maxContextTokens: 100000,
			};

			let text = '';
			let toolCalls = 0;
			const maxSteps = 10;

			// Phase 3: create independent ToolExecutor for worktree agents
			let worktreeExecutor: any = null;
			if (worktreePath) {
				const { ToolExecutor } = await import('../browser/toolExecutor.js');
				worktreeExecutor = new ToolExecutor(
					this.fileService, this.logService, this.diffStore,
					this.indexService, this.markerService, this.workspaceContextService,
					this.configurationService, abort.signal,
					undefined, undefined, undefined,
					undefined, undefined, undefined,
					worktreePath,
				);
			}

			for (let step = 0; step < maxSteps; step++) {
				if (abort.signal.aborted) {
					return { name: config.name, status: 'aborted', text: 'Sub-agent aborted', toolCalls };
				}

				const result = await this._callLLM(messages, tools, options, abort.signal);
				if (result.type === 'end_turn') {
					text = result.text || '';
					break;
				}
				if (result.type === 'tool_use') {
					toolCalls++;
					messages.push({
						role: 'assistant',
						content: [{ type: 'tool_use', id: result.toolCallId || '', name: result.toolName || '', input: result.toolInput || {} }],
					});
					let toolResult: string;
					if (worktreeExecutor && result.toolName) {
						try {
							toolResult = await worktreeExecutor.execute(result.toolName, result.toolInput || {});
						} catch (e: any) {
							toolResult = `Error: ${e.message}`;
						}
					} else {
						toolResult = '[Sub-agent tool execution via parent ToolExecutor]';
					}
					messages.push({
						role: 'tool',
						content: [{ type: 'tool_result', tool_use_id: result.toolCallId || '', content: toolResult, is_error: toolResult.startsWith('Error') }],
					});
				}
				if (result.type === 'error') {
					return { name: config.name, status: 'error', text: '', error: result.text, toolCalls };
				}
			}

			return {
				name: config.name,
				status: 'completed',
				text,
				toolCalls,
			};
		} catch (err: any) {
			return { name: config.name, status: 'error', text: '', error: err?.message || String(err), toolCalls: 0 };
		} finally {
			if (worktreePath) {
			await this._cleanupWorktree(worktreePath).catch(e =>
				this.logService.warn('[SubAgentManager] worktree cleanup failed:', e)
			);
		}
		this._running.delete(config.name);
		}
	}

	private _buildToolSet(subagentType: string): AITool[] {
		const allowed = TOOL_SETS[subagentType];
		if (!allowed || !allowed.length) return [];
		return [];
	}

	// --- Worktree isolation (Phase 3) ---------------------------------------

	private async _createWorktree(name: string): Promise<string> {
		const repoRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!repoRoot) throw new Error('No workspace for worktree creation');
		const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
		const worktreePath = `${repoRoot}_wt_${sanitized}_${Date.now()}`;
		await this._execShell(`git -C "${repoRoot}" worktree add --detach "${worktreePath}" HEAD`, repoRoot);
		this.logService.info(`[SubAgentManager] Created worktree: ${worktreePath}`);
		return worktreePath;
	}

	private async _cleanupWorktree(worktreePath: string): Promise<void> {
		await this._execShell(`git worktree remove --force "${worktreePath}"`, worktreePath);
		this.logService.info(`[SubAgentManager] Removed worktree: ${worktreePath}`);
	}

	private async _execShell(cmd: string, cwd: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		if ((globalThis as any).vscode?.ipcRenderer?.invoke) {
			return (globalThis as any).vscode.ipcRenderer.invoke('vscode:ai-studio:exec', {
				cmd, cwd, timeoutMs, maxBuffer: 1024 * 1024,
			});
		}
		return { stdout: '', stderr: 'IPC bridge not available', exitCode: -1 };
	}

	private _callLLM(
		messages: AIMessage[],
		tools: AITool[],
		options: AIRequestOptions,
		signal: AbortSignal,
	): Promise<{ type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; toolCallId?: string }> {
		return new Promise((resolve, reject) => {
			let text = '';
			let resolved = false;
			let tName = '', tInput: Record<string, unknown> = {}, tId = '';

			const cb: AIStreamCallbacks = {
				onToken: (t: string) => { text += t; },
				onToolUse: (name, input, callId) => { tName = name; tInput = input; tId = callId; },
				onToolResult: () => {},
				onError: (err) => { if (!resolved) { resolved = true; reject(err); } },
				onDone: (reason) => {
					if (!resolved) {
						resolved = true;
						if (reason === 'tool_use' || tName) {
							resolve({ type: 'tool_use', text, toolName: tName, toolInput: tInput, toolCallId: tId });
						} else {
							resolve({ type: 'end_turn', text });
						}
					}
				},
			};

			const ctl = this.aiModelService.streamChat(messages, tools, options, cb);
			if (signal.aborted) {
				ctl.abort();
				reject(new Error('Aborted'));
				return;
			}
			const onAbort = () => { ctl.abort(); if (!resolved) { resolved = true; reject(new Error('Aborted')); } };
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}
}
