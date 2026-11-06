/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../base/common/types.js';

import { localize } from '../../nls.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { IMenuItem, ISubmenuItem, isIMenuItem, MenuId, MenuRegistry } from '../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';

export const STUDIO_ADVANCED_MODE_CONFIG = 'aiStudio.advancedMode';
export const STUDIO_ADVANCED_MODE_CONTEXT = `config.${STUDIO_ADVANCED_MODE_CONFIG}`;
export const STUDIO_SETTINGS_COMMAND = 'aiStudio.settings.open';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'aiStudio',
	title: localize('studio.configuration', "AI Studio"),
	type: 'object',
	properties: {
		[STUDIO_ADVANCED_MODE_CONFIG]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('studio.advancedMode', "显示终端、调试、扩展和完整编辑器设置等专业功能。关闭后保留项目、会话和日常设置。"),
		}
	}
});

export function isStudioAdvancedMode(configurationService: Pick<IConfigurationService, 'getValue'>): boolean {
	return configurationService.getValue<boolean>(STUDIO_ADVANCED_MODE_CONFIG) === true;
}

// This is a presentation policy, never an execution allowlist. Commands and
// services remain available to agents, extensions and editor internals.
const simpleCommands = new Set([
	'ai.settings',
	'chat.modelConfiguration.open',
	'workbench.action.chat.configure.skills',
	'workbench.command.new.skill',
	'workbench.action.chat.configure.instructions',
	'workbench.action.chat.configure.agents',
	'workbench.mcp.addConfiguration',
	'workbench.action.openSettings',
	'workbench.action.showCommands',
	'workbench.action.selectTheme',
	'workbench.action.files.newUntitledFile',
	'workbench.action.newWindow',
	'workbench.action.files.openFile',
	'workbench.action.files.openFolder',
	'workbench.action.files.openFileFolder',
	'workbench.action.openFolder',
	'workbench.action.openRecent',
	'workbench.action.clearRecentFiles',
	'workbench.action.files.save',
	'workbench.action.files.saveAs',
	'workbench.action.files.saveAll',
	'workbench.action.files.saveFiles',
	'workbench.action.files.revert',
	'workbench.action.toggleAutoSave',
	'workbench.action.closeActiveEditor',
	'workbench.action.closeWindow',
	'workbench.action.closeFolder',
	'workbench.action.quit',
	'undo', 'redo', 'editor.action.clipboardCutAction', 'editor.action.clipboardCopyAction',
	'editor.action.clipboardPasteAction', 'editor.action.selectAll', 'actions.find',
	'editor.action.startFindReplaceAction', 'editor.action.webvieweditor.selectAll',
	'workbench.action.toggleFullScreen',
	'workbench.action.zoomIn',
	'workbench.action.zoomOut',
	'workbench.action.zoomReset',
	'workbench.action.minimizeWindow',
	'workbench.action.zoomWindow',
	'workbench.action.showAboutDialog',
	'workbench.action.openDocumentationUrl',
	'workbench.action.openIssueReporter',
	'workbench.action.showReleaseNotes',
	'update.checkForUpdate', 'update.downloadUpdate', 'update.installUpdate', 'update.restartToUpdate',
]);

export function isStudioSimpleCommand(commandId: string): boolean {
	return commandId.startsWith('aiStudio.') || commandId.startsWith('ai.chat.') || simpleCommands.has(commandId);
}

const simpleSubmenus = new Set([
	MenuId.MenubarFileMenu, MenuId.MenubarEditMenu, MenuId.MenubarViewMenu,
	MenuId.MenubarHelpMenu, MenuId.MenubarPreferencesMenu, MenuId.MenubarRecentMenu,
	MenuId.MenubarAppearanceMenu,
]);

function isProfessionalEntry(commandId: string): boolean {
	return /^(?:workbench\.(?:action\.(?:terminal\.|debug\.|tasks\.|open(?:SettingsJson|GlobalKeybindings|DefaultSettings|RawDefaultSettings|RawUserSettings|WorkspaceSettings|FolderSettings|RemoteSettings|ApplicationSettings)|configure)|debug\.|extensions\.|view\.(?:extensions|debug))|debug\.|editor\.action\.debug\.)/.test(commandId);
}

/** Curate global entry points; retain normal editing and agent tool menus. */
export function isStudioSimpleMenuItem(menu: MenuId, item: IMenuItem | ISubmenuItem): boolean {
	const curated = menu === MenuId.CommandPalette || menu === MenuId.GlobalActivity || menu.id.startsWith('Menubar');
	if (isIMenuItem(item)) {
		return curated
			? isStudioSimpleCommand(item.command.id) && (!item.alt || isStudioSimpleCommand(item.alt.id))
			: !isProfessionalEntry(item.command.id) && (!item.alt || !isProfessionalEntry(item.alt.id));
	}
	return !curated || simpleSubmenus.has(item.submenu);
}

// Appended conditions participate in MenuService's existing context-key
// tracking, so already-open toolbars and the native menu update in place.
MenuRegistry.registerMenuItemConditionProvider((menu, item) => isStudioSimpleMenuItem(menu, item)
	? undefined
	: ContextKeyExpr.equals(STUDIO_ADVANCED_MODE_CONTEXT, true));

// Route only these user-facing default shortcuts. Their original commands and
// services still work for the agent and for shell layout restoration. Explicit
// user keybindings keep their normal priority over application defaults.
for (const binding of [
	{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyX },
	{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD },
	{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY },
	{ primary: KeyMod.CtrlCmd | KeyCode.Backquote, mac: { primary: KeyMod.WinCtrl | KeyCode.Backquote } },
	{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backquote, mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Backquote } },
	{ primary: KeyCode.F5, when: ContextKeyExpr.equals('debugState', 'inactive') },
	{ primary: KeyMod.CtrlCmd | KeyCode.F5, mac: { primary: KeyMod.WinCtrl | KeyCode.F5 } },
]) {
	KeybindingsRegistry.registerKeybindingRule({
		...binding,
		id: STUDIO_SETTINGS_COMMAND,
		args: 'advanced',
		weight: KeybindingWeight.WorkbenchContrib + 50,
		when: ContextKeyExpr.and(ContextKeyExpr.notEquals(STUDIO_ADVANCED_MODE_CONTEXT, true), hasKey(binding, { when: true }) ? binding.when : undefined),
	});
}
