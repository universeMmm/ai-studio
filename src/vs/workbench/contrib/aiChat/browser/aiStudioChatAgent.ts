/*---------------------------------------------------------------------------------------------
 *  AI Studio - Chat Agent with Tool-Use Loop
 *  Registers as VS Code's default chat agent. Delegates the agent loop to
 *  IAIAgentService so there is one canonical implementation shared across
 *  the Chat panel, the status bar, and any other surface.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { ExtensionIdentifier } from "../../../../platform/extensions/common/extensions.js";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from "../../../../workbench/common/contributions.js";
import { IAIAgentService } from "../../../../platform/ai/browser/aiAgentService.js";
import type { AgentStep } from "../../../../platform/ai/common/aiTypes.js";
import {
	IChatAgentService,
	type IChatAgentData,
	type IChatAgentImplementation,
	type IChatAgentRequest,
	type IChatAgentResult,
} from "../../../../workbench/contrib/chat/common/participants/chatAgents.js";
import type { IChatProgress } from "../../../../workbench/contrib/chat/common/chatService/chatService.js";
import { ChatModeKind, ChatAgentLocation } from "../../../../workbench/contrib/chat/common/constants.js";
import { ThemeIcon } from "../../../../base/common/themables.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import type { AskUserQuestionInput } from "../../../../platform/ai/common/aiTypes.js";
import { IDiffStore } from "../../aiDiffApply/browser/diffStore.js";
import { URI } from "../../../../base/common/uri.js";

const AI_STUDIO_AGENT_ID = "ai-studio.chat";

class AIStudioChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = "vs.contrib.aiStudioChatAgent";

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILogService private readonly logService: ILogService,
		@IDiffStore private readonly diffStore: IDiffStore,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) { super(); this._registerAgent(); }

	private _registerAgent(): void {
		const data: IChatAgentData = {
			id: AI_STUDIO_AGENT_ID, name: "AI Studio", fullName: "AI Studio Agent",
			description: "AI Studio - self-hosted coding assistant",
			isDefault: true, isCore: true,
			extensionId: new ExtensionIdentifier("ai-studio"), extensionVersion: "1.0.0",
			extensionPublisherId: "ai-studio", extensionDisplayName: "AI Studio", publisherDisplayName: "AI Studio",
			metadata: { themeIcon: ThemeIcon.fromId("robot"), sampleRequest: "Help me write a function", isSticky: false },
			slashCommands: [], locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline, ChatAgentLocation.Terminal],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			disambiguation: [{ category: "ai_studio", description: "AI Studio coding assistant", examples: ["write a function", "fix this bug", "explain this code"] }],
		};
		const impl: IChatAgentImplementation = {
			invoke: (req: any, prog: any, _hist: any, tok: any) => this._invoke(req, prog, tok),
		};
		this._register(this.chatAgentService.registerAgent(AI_STUDIO_AGENT_ID, data));
		this._register(this.chatAgentService.registerAgentImplementation(AI_STUDIO_AGENT_ID, impl));
	}

	private async _invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		try {
			const agentService = this.instantiationService.invokeFunction(
				a => a.get(IAIAgentService));

			this.logService.info('[AIStudioChatAgent] _invoke called, message:', request.message.slice(0, 100));

			// Convert agent steps into chat progress as they arrive.
			// Skip the initial echo (step whose content matches the user's message).
			let firstThought = true;
			const stepListener = agentService.onDidAddStep((step: AgentStep) => {
				this.logService.info('[AIStudioChatAgent] onDidAddStep type=' + step.type + ' content=' + step.content.slice(0, 80));
				switch (step.type) {
					case "thought":
						if (firstThought && step.content === request.message) {
							this.logService.info('[AIStudioChatAgent] Skipping first thought (echo of user message)');
							firstThought = false;
							return;
						}
						firstThought = false;
						this.logService.info('[AIStudioChatAgent] Calling progress() with markdownContent, length=' + step.content.length);
						progress([{ content: new MarkdownString(step.content), kind: "markdownContent" }]);
						this.logService.info('[AIStudioChatAgent] progress() returned');
						break;
					case "tool_use":
						progress([{ kind: "progressMessage", content: new MarkdownString("Tool: **" + (step.toolName || "?") + "**") }]);
						break;
					case "tool_result":
						// Diff content should persist as markdown in the chat response
						if (step.content.startsWith("### Edited:") || step.content.includes("```diff")) {
							progress([{ kind: "markdownContent", content: new MarkdownString(step.content) }]);
						} else {
							progress([{ kind: "progressMessage", content: new MarkdownString(step.content.slice(0, 500)) }]);
						}
						break;
					case "error":
						progress([{ kind: "progressMessage", content: new MarkdownString("**Error:** " + step.content) }]);
						break;
				}
			});

			// Render task progress as a markdown checklist
			const taskListener = agentService.onDidChangeTasks((tasks) => {
				if (!tasks || !tasks.length) return;
				const total = tasks.filter(t => t.status !== 'deleted').length;
				const completed = tasks.filter(t => t.status === 'completed').length;
				const inProgress = tasks.filter(t => t.status === 'in_progress').length;
				let md = '## Tasks (' + completed + '/' + total + ' done';
				if (inProgress > 0) md += ', ' + inProgress + ' in progress';
				md += ')\n';
				for (const t of tasks) {
					if (t.status === 'deleted') continue;
					const icon = t.status === 'completed' ? '- [x]' : t.status === 'in_progress' ? '- [>]' : '- [ ]';
					let label = t.subject;
					if (t.owner) label += ' _(owner: ' + t.owner + ')_';
					md += icon + ' **' + label + '**';
					if (t.description) md += ': ' + t.description;
					md += '\n';
				}
				progress([{ content: new MarkdownString(md), kind: 'markdownContent' }]);
			});

		// Phase 3: Plan approval — present plan review via QuickPick
		const planListener = agentService.onDidEnterPlanMode(({ planFile, content }) => {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString('## Implementation Plan\n\n' + content.slice(0, 3000) + (content.length > 3000 ? '\n\n*(truncated)*' : '')),
			}]);
			this.quickInputService.pick([
				{ label: '$(check) Approve', description: 'Approve the plan and start implementing', id: 'approve' },
				{ label: '$(close) Reject', description: 'Reject the plan and stop', id: 'reject' },
			], {
				title: 'Approve Implementation Plan',
				placeHolder: 'Plan written to ' + planFile,
			}).then((selected) => {
				agentService.approvePlan(selected?.id === 'approve');
			});
		});

		const cancelListener = token.onCancellationRequested(() => agentService.stop());

			// Phase 3: AskUserQuestion — present QuickPick to user and return answer
			const questionListener = agentService.onDidAskQuestion((qInput: AskUserQuestionInput) => {
				const picks = qInput.options.map((o, i) => ({
					label: o.label,
					description: o.description,
					id: String(i),
				}));
				if (!qInput.multiSelect) {
					picks.push({ label: '$(edit) Other (custom answer)...', description: 'Type your own answer', id: '__custom__' });
				}
				this.quickInputService.pick(picks, {
					title: qInput.header || qInput.question,
					placeHolder: qInput.question,
							canPickMany: qInput.multiSelect as any,
				}).then((selected) => {
					if (!selected) {
						agentService.answerQuestion('(user cancelled)');
						return;
					}
					if (qInput.multiSelect && Array.isArray(selected)) {
						agentService.answerQuestion(selected.map(s => s.label).join(', '));
					} else if (!Array.isArray(selected) && (selected as any).id === '__custom__') {
						this.quickInputService.input({
							title: 'Answer',
							placeHolder: 'Type your answer...',
						}).then((value) => {
							agentService.answerQuestion(value || '(no answer)');
						});
					} else {
						const sel = Array.isArray(selected) ? selected[0] : selected;
						agentService.answerQuestion(sel.label);
					}
				});
			});

			try {
				// Extract implicit file attachments from request variables
				let userMessage = request.message;
				const vars = (request as any).variables?.variables as any[] | undefined;
				if (vars && vars.length > 0) {
					const implicitFiles = vars.filter((v: any) =>
						(v.kind === 'file' || (v.value && typeof v.value === 'object' && v.value.fsPath)) &&
						!v.range
					);
					if (implicitFiles.length > 0) {
						let fileBlock = '\n\n## Attached Files\n';
						for (const f of implicitFiles) {
							const uri = f.value;
							const fp = (typeof uri === 'object' && uri.fsPath) ? uri.fsPath :
								(typeof uri === 'object' && uri.path) ? uri.path : String(uri || f.name || 'unknown');
							fileBlock += `- ${fp}\n`;
						}
						userMessage += fileBlock;
					}
				}
				await agentService.run(userMessage);
				this.logService.info('[AIStudioChatAgent] agentService.run() completed');

				// Build multiDiffData from the diffStore to show an interactive file change list
				const appliedHunks = this.diffStore.getAllAppliedHunks();
				if (appliedHunks.length > 0) {
					const fileMap = new Map<string, { added: number; removed: number }>();
					for (const h of appliedHunks) {
						const entry = fileMap.get(h.filePath) || { added: 0, removed: 0 };
						if (h.originalText) entry.removed += h.originalText.split('\n').length;
						if (h.modifiedText) entry.added += h.modifiedText.split('\n').length;
						fileMap.set(h.filePath, entry);
					}

					const resources = Array.from(fileMap.entries()).map(([filePath, stats]) => ({
						modifiedUri: URI.file(filePath),
						goToFileUri: URI.file(filePath),
						added: stats.added,
						removed: stats.removed,
					}));

					progress([{
						kind: "multiDiffData",
						multiDiffData: {
							title: `Changed ${fileMap.size} file(s)`,
							resources,
						},
						collapsed: false,
					} as any]);
				}
			} finally {
				stepListener.dispose();
				taskListener.dispose();
				questionListener.dispose();
				planListener.dispose();
				cancelListener.dispose();
			}

			return {};
		} catch (err: any) {
			progress([{ kind: "progressMessage", content: new MarkdownString("**AI Studio Error:** " + (err?.message || String(err))) }]);
			return { errorDetails: { message: err?.message || String(err) } };
		}
	}
}

registerWorkbenchContribution2(AIStudioChatAgentContribution.ID, AIStudioChatAgentContribution, WorkbenchPhase.AfterRestored);
