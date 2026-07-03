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

const AI_STUDIO_AGENT_ID = "ai-studio.chat";

class AIStudioChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = "vs.contrib.aiStudioChatAgent";

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
	) { super(); this._registerAgent(); }

	private _registerAgent(): void {
		const data: IChatAgentData = {
			id: AI_STUDIO_AGENT_ID, name: "AI Studio", fullName: "AI Studio Agent",
			description: "AI Studio - self-hosted coding assistant",
			isDefault: true, isCore: true,
			extensionId: new ExtensionIdentifier("ai-studio"), extensionVersion: "1.0.0",
			extensionPublisherId: "ai-studio", extensionDisplayName: "AI Studio", publisherDisplayName: "AI Studio",
			metadata: { themeIcon: ThemeIcon.fromId("robot"), sampleRequest: "Help me write a function", isSticky: true },
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

			// Convert agent steps into chat progress as they arrive.
			// Skip the initial echo (step whose content matches the user's message).
			let firstThought = true;
			const stepListener = agentService.onDidAddStep((step: AgentStep) => {
				switch (step.type) {
					case "thought":
						if (firstThought && step.content === request.message) {
							firstThought = false;
							return;
						}
						firstThought = false;
						progress([{ content: new MarkdownString(step.content), kind: "markdownContent" }]);
						break;
					case "plan":
						progress([{ content: new MarkdownString(step.content), kind: "markdownContent" }]);
						break;
					case "tool_use":
						progress([{ kind: "progressMessage", content: new MarkdownString("Tool: **" + (step.toolName || "?") + "**") }]);
						break;
					case "tool_result":
						progress([{ kind: "progressMessage", content: new MarkdownString(step.content.slice(0, 500)) }]);
						break;
					case "error":
						progress([{ kind: "progressMessage", content: new MarkdownString("**Error:** " + step.content) }]);
						break;
				}
			});

			// Render plan progress as a markdown checklist
			const planListener = agentService.onDidChangePlan((plan) => {
				if (!plan) return;
				const completed = plan.steps.filter(s => s.status === "completed").length;
				const total = plan.steps.length;
				let md = "## Plan Progress (" + completed + "/" + total + ")\n";
				for (const s of plan.steps) {
					const icon = s.status === "completed" ? "- [x]" : s.status === "in_progress" ? "- [>]" : "- [ ]";
					md += icon + " **" + s.title + "**: " + s.description + "\n";
				}
				progress([{ content: new MarkdownString(md), kind: "markdownContent" }]);
			});

			const cancelListener = token.onCancellationRequested(() => agentService.stop());

			try {
				await agentService.run(request.message);
			} finally {
				stepListener.dispose();
				planListener.dispose();
				cancelListener.dispose();
			}

			// Only emit execution summary when tools were actually used
			const steps = agentService.steps;
			const toolSteps = steps.filter(s => s.type === "tool_use" || s.type === "tool_result");
			if (toolSteps.length > 0) {
				let summary = "## Execution Summary\n| # | Type | Action |\n|---|---|---|\n";
				for (const s of steps) {
					if (s.type === "thought" && s.content === request.message) continue;
					const typeIcon = s.type === "tool_use" ? "$(tools)" : s.type === "tool_result" ? "$(output)" : s.type === "error" ? "$(error)" : "$(comment)";
					summary += "| " + s.stepNumber + " | " + typeIcon + " " + s.type + " | " + s.content.substring(0, 80).replace(/\n/g, ' ') + " |\n";
				}
				progress([{ content: new MarkdownString(summary), kind: "markdownContent" }]);
			}
			return {};
		} catch (err: any) {
			progress([{ kind: "progressMessage", content: new MarkdownString("**AI Studio Error:** " + (err?.message || String(err))) }]);
			return { errorDetails: { message: err?.message || String(err) } };
		}
	}
}

registerWorkbenchContribution2(AIStudioChatAgentContribution.ID, AIStudioChatAgentContribution, WorkbenchPhase.AfterRestored);
