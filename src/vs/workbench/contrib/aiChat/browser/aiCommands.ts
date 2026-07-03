/*---------------------------------------------------------------------------------------------
 *  AI Studio — Command Registrations
 *  Commands and keyboard shortcuts for AI features.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import './media/aiChat.css';

const AI_CHAT_VIEW_ID = 'workbench.panel.chat.view.ai-studio';

// ── AI: Open Chat Panel ──────────────────────────────────────
CommandsRegistry.registerCommand({
	id: 'ai.chat.open',
	handler: (accessor) => {
		const viewsService = accessor.get(IViewsService);
		return viewsService.openView(AI_CHAT_VIEW_ID);
	},
	metadata: { description: 'AI: Open Chat Panel' },
});

// ── AI: Reindex Workspace ────────────────────────────────────
CommandsRegistry.registerCommand({
	id: 'ai.reindex',
	handler: async (accessor) => {
		const { IAIIndexService } = await import('../../../../platform/ai/browser/aiIndexService.js');
		const indexService = accessor.get(IAIIndexService);
		await indexService.reindex();
	},
	metadata: { description: 'AI: Reindex Workspace' },
});

// ── AI: Open Settings ────────────────────────────────────────
CommandsRegistry.registerCommand({
	id: 'ai.settings',
	handler: async (accessor) => {
		const { IPreferencesService } = await import('../../../../workbench/services/preferences/common/preferences.js');
		const prefsService = accessor.get(IPreferencesService);
		prefsService.openUserSettings({ query: 'ai.' });
	},
	metadata: { description: 'AI: Open Settings' },
});

// ── Ctrl+L → open AI Chat ────────────────────────────────────
KeybindingsRegistry.registerKeybindingRule({
	id: 'ai.chat.open',
	primary: KeyMod.CtrlCmd | KeyCode.KeyL,
	weight: 200,
});
