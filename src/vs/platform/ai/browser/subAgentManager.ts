/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Sub-Agent Manager
 *  Manages sub-agent lifecycle: creation, parallel execution, result aggregation.
 *  Also handles SendMessage routing between agents (merged from agentCommunicator).
 *
 *  Sub-agents run in-process: each is a mini agent loop with its own
 *  ConversationMemory, restricted tool set, and independent system prompt.
 *  Multiple sub-agents can execute in parallel via Promise.all().
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/log.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import type { AIMessage, AIMessageContent, AIRequestOptions, SubAgentConfig, SubAgentResult } from '../common/aiTypes.js';
import { getBuiltInTools } from '../common/aiTools.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { hasKey } from '../../../base/common/types.js';
import { getAIStudioIpcRenderer, type AIStudioCommandResult } from '../common/desktopIpc.js';
import { assistantToolMessage, collectAgentTurn, executeToolBatch, toolResult, validateToolCall } from '../common/toolRuntime.js';

import { IAIModelService } from './aiModelService.js';
import { IAIIndexService } from './aiIndexService.js';
import { IDiffStore } from '../../../workbench/contrib/aiDiffApply/browser/diffStore.js';
import { IMarkerService } from '../../../platform/markers/common/markers.js';

import { ISubAgentManager, type SubAgentExecutionContext } from '../common/subAgentManager.js';

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
	private _running: Map<string, { inbox: AIMessage[]; abort: AbortController }> = new Map();

	constructor(
		@IAIModelService private readonly aiModelService: IAIModelService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAIIndexService private readonly indexService: IAIIndexService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IMarkerService private readonly markerService: IMarkerService,
	) { }

	async execute(configs: SubAgentConfig[], context: SubAgentExecutionContext = {}): Promise<SubAgentResult[]> {
		const names = new Set(this._running.keys());
		const namedConfigs = configs.map(config => {
			const base = config.name || config.subagent_type;
			let name = base;
			let suffix = 1;
			while (names.has(name)) { name = base + '-' + (++suffix); }
			names.add(name);
			return { ...config, name };
		});
		const promises = namedConfigs.map(config => this._runSingle(config, context));
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
			if (!target) { continue; }

			// Protocol messages
			if (typeof message === 'object' && hasKey(message, { type: true })) {
				const msg = message as { type: string; approve?: boolean; request_id?: string };
				if (msg.type === 'shutdown_response' && msg.approve) {
					target.abort.abort();
					this.logService.info(`[SubAgentManager] ${targetName} shutdown via ${from}`);
					continue;
				}
			}
			const body = typeof message === 'string' ? message : JSON.stringify(message);
			target.inbox.push({ role: 'user', content: '[Message from ' + from + '] ' + summary + '\n' + body });
		}
	}

	getRunningAgents(): string[] {
		return Array.from(this._running.keys());
	}

	// --- Internal ---------------------------------------------------------------

	private async _runSingle(config: SubAgentConfig & { name: string }, context: SubAgentExecutionContext): Promise<SubAgentResult> {
		const inbox: AIMessage[] = [];
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		context.signal?.addEventListener('abort', onAbort, { once: true });
		if (context.signal?.aborted) { abort.abort(); }
		this._running.set(config.name, { inbox, abort });

		let worktreePath: string | undefined;
		let initialHead: string | undefined;
		const result: SubAgentResult = { name: config.name, status: 'error', text: '', toolCalls: 0 };
		try {
			abort.signal.throwIfAborted();
			if (!Object.hasOwn(TOOL_SETS, config.subagent_type)) { throw new Error('Unknown sub-agent type.'); }
			if (config.run_in_background) { throw new Error('Only foreground sub-agents are supported.'); }
			if (config.isolation === 'worktree') {
				const root = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				if (!root) { throw new Error('No workspace for worktree creation'); }
				const path = root + '_wt_' + generateUuid();
				if (!await context.approve?.('git worktree add --detach ' + JSON.stringify(path) + ' HEAD', root, abort.signal)) {
					throw new Error('Worktree creation was declined.');
				}
				abort.signal.throwIfAborted();
				await this._git(root, ['worktree', 'add', '--detach', path, 'HEAD']);
				worktreePath = path;
				initialHead = await this._git(path, ['rev-parse', 'HEAD']);
			}
			const allowed = TOOL_SETS[config.subagent_type];
			const tools = getBuiltInTools().filter(tool => !allowed.length || allowed.includes(tool.name));
			const messages: AIMessage[] = [
				{ role: 'system', content: SYSTEM_PROMPTS[config.subagent_type] + (worktreePath ? '\nWorking directory: ' + worktreePath : '') },
				{ role: 'user', content: config.prompt || config.description },
			];
			const options: AIRequestOptions = {
				model: '', maxTokens: 8000, temperature: 0, thinking: false, cacheSystemPrompt: true, maxContextTokens: 100000,
			};
			const { ToolExecutor } = await import('./toolExecutor.js');
			const executor = new ToolExecutor(
				this.fileService, this.logService, this.diffStore, this.indexService, this.markerService,
				this.workspaceContextService, this.configurationService, abort.signal,
				undefined, undefined, undefined, undefined, undefined, undefined, worktreePath, context,
			);
			for (let step = 0; step < 10; step++) {
				messages.push(...inbox.splice(0));
				const turn = await collectAgentTurn(this.aiModelService, messages, tools, options, abort.signal);
				if (!turn.calls.length) {
					result.status = 'completed';
					result.text = turn.text;
					break;
				}
				messages.push(assistantToolMessage(turn));
				const blocks = await executeToolBatch(turn.calls, async call => {
					result.toolCalls++;
					const definition = tools.find(tool => tool.name === call.name);
					if (!definition) { return toolResult(call.id, 'This tool is unavailable to this sub-agent.', 'denied'); }
					const invalid = validateToolCall(call, definition);
					if (invalid) { return toolResult(call.id, invalid, 'error'); }
					const images: AIMessageContent[] = [];
					const output = await executor.executeCall(call.name, call.input, source => images.push({ type: 'image', source }), context.approve);
					if (!worktreePath && output.outcome === 'success' && (call.name === 'write_file' || call.name === 'edit_file')) {
						try { await this.indexService.indexFile(call.input.path as string); }
						catch (error) { this.logService.warn('[SubAgentManager] Incremental indexing failed:', error); }
					}
					return toolResult(call.id, output.text, output.outcome, images);
				}, abort.signal);
				messages.push({ role: 'tool', content: blocks });
			}
			if (result.status !== 'completed') { result.error = 'Sub-agent reached its tool turn limit.'; }
		} catch (error) {
			result.status = abort.signal.aborted ? 'aborted' : 'error';
			result.error = error instanceof Error ? error.message : String(error);
		} finally {
			context.signal?.removeEventListener('abort', onAbort);
			this._running.delete(config.name);
			if (worktreePath) {
				try {
					await this._removeWorktree(worktreePath, initialHead);
				} catch (error) {
					const retained = 'Worktree retained at ' + worktreePath;
					result.text += '\n' + retained;
					if (result.error) { result.error += '\n' + retained; }
					this.logService.warn('[SubAgentManager] ' + retained, error);
				}
			}
		}
		return result;
	}

	private async _removeWorktree(worktreePath: string, initialHead: string | undefined): Promise<void> {
		if (initialHead !== await this._git(worktreePath, ['rev-parse', 'HEAD'])) {
			throw new Error('Worktree contains new commits.');
		}
		await this._git(this.workspaceContextService.getWorkspace().folders[0].uri.fsPath, ['worktree', 'remove', worktreePath]);
	}

	private async _git(cwd: string, args: string[]): Promise<string> {
		const ipc = getAIStudioIpcRenderer();
		if (!ipc?.invoke) { throw new Error('Git worktree creation requires the desktop process.'); }
		const result = await ipc.invoke<AIStudioCommandResult>('vscode:ai-studio:exec', {
			command: 'git', args, cwd, timeout: 30000, maxBuffer: 1024 * 1024, shell: false, requestId: generateUuid(),
		});
		if (result.exitCode !== 0) { throw new Error(result.stderr || 'Git worktree command failed.'); }
		return result.stdout.trim();
	}
}
