/*---------------------------------------------------------------------------------------------
 *  AI Studio - Context Service
 *  Assemblies the full agent context: editor snapshot, index search results,
 *  conversation history, and active plan.  Centralizes prompt construction
 *  so Agent doesn't assemble its own strings.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../base/common/lifecycle.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import { IActiveCodeEditor } from '../../../editor/browser/editorBrowser.js';
import type { AIMessage, CodeSnippet } from "../common/aiTypes.js";
import { SYSTEM_PROMPT } from '../common/systemPrompt.js';
import { ConversationMemory } from "../common/conversationMemory.js";
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ProjectRules } from '../common/projectRules.js';
import { IUserMemoryStore } from '../common/userMemoryStore.js';

export const IAIContextService = createDecorator<IAIContextService>("aiContextService");

export interface BuildContextInput {
	instruction: string;
	memory: ConversationMemory;
	topK: number;
}

export interface IAIContextService {
	readonly _serviceBrand: undefined;
	buildContext(input: BuildContextInput): Promise<AIMessage[]>;
	getEditorContext(): { filePath: string; languageId: string; line: number; column: number; selection: string };
	searchRelevant(query: string, topK: number): Promise<CodeSnippet[]>;
}

export class AIContextService extends Disposable implements IAIContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserMemoryStore private readonly userMemoryStore: IUserMemoryStore,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { super(); }

	// ---- Public API ---------------------------------------------------------

	async buildContext(input: BuildContextInput): Promise<AIMessage[]> {
		const messages: AIMessage[] = [];
		let systemPrompt = SYSTEM_PROMPT + "\n";
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath || '.';
		const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
		const rules = new ProjectRules(workspaceRoot, this.fileService, this.logService, homeDir);
		const rulesBlock = await rules.load();
		if (rulesBlock) systemPrompt += rulesBlock;

		// 1. Editor context
		const editor = this.getEditorContext();
		if (editor.filePath) {
			systemPrompt += "\n## Current Editor\nFile: " + editor.filePath
				+ " (" + editor.languageId + ")\nCursor: line " + editor.line + ", col " + editor.column;
			if (editor.selection) systemPrompt += "\nSelection: " + editor.selection.slice(0, 200);
			systemPrompt += "\n";
		}

		// 2. User memory context
		try {
			if (this.userMemoryStore) {
				const entries = await this.userMemoryStore.list();
				if (entries.length) {
					systemPrompt += '\n## User Memory\n\n';
					systemPrompt += 'You have a persistent memory system at `~/.ai-studio/memory/`.\n';
					systemPrompt += 'The following memories are available (use LocalMemoryRecall to read details):\n';
					for (const e of entries) {
						systemPrompt += `- **${e.name}** (${e.type}): ${e.description}\n`;
					}
					systemPrompt += '\n';
				}
			}
		} catch { /* memory unavailable */ }

		// 3. User-defined slash commands
		try {
			const slashCommands = this.configurationService.getValue<Record<string, { description?: string; prompt: string }>>('ai.slashCommands');
			if (slashCommands && Object.keys(slashCommands).length > 0) {
				systemPrompt += '\n## User-Defined Slash Commands\n\n';
				for (const [name, cmd] of Object.entries(slashCommands)) {
					systemPrompt += `- **/${name}**${cmd.description ? ': ' + cmd.description : ''}\n  → ${cmd.prompt}\n`;
				}
				systemPrompt += '\n';
			}
		} catch { /* slash commands unavailable */ }

		messages.push({ role: "system", content: systemPrompt });

		// 4. Conversation history
		const historyMsgs = input.memory.toMessages();
		for (const m of historyMsgs) { messages.push(m); }

		// 5. Current instruction
		messages.push({ role: "user", content: input.instruction });

		return messages;
	}

	getEditorContext(): { filePath: string; languageId: string; line: number; column: number; selection: string } {
		const editor = this.editorService.activeTextEditorControl as IActiveCodeEditor | undefined;
		if (!editor || !('getModel' in editor)) return { filePath: "", languageId: "", line: 0, column: 0, selection: "" };
		const model = editor.getModel();
		const sel = editor.getSelection();
		return {
			filePath: model?.uri?.fsPath || model?.uri?.path || "",
			languageId: model?.getLanguageId?.() || "",
			line: sel?.positionLineNumber || sel?.startLineNumber || 0,
			column: sel?.positionColumn || sel?.startColumn || 0,
			selection: model?.getValueInRange?.(sel) || "",
		};
	}

	async searchRelevant(query: string, topK: number): Promise<CodeSnippet[]> {
		// Delegate to IndexService at call site — this stub is kept for DI interface compatibility
		return [];
	}
}
