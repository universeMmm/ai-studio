/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { ConfigurationModelParser } from '../../../platform/configuration/common/configurationModels.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ResolvedKeybindingItem } from '../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { isStudioSimpleCommand, isStudioSimpleMenuItem, STUDIO_ADVANCED_MODE_CONFIG, STUDIO_ADVANCED_MODE_CONTEXT, STUDIO_SETTINGS_COMMAND } from '../../common/studioMode.js';
import { WORKSPACE_SCOPES } from '../../services/configuration/common/configuration.js';

suite('Studio presentation mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('simple mode is the application default and a workspace cannot enable advanced mode', () => {
		const property = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties()[STUDIO_ADVANCED_MODE_CONFIG];
		assert.strictEqual(property.default, false);
		assert.strictEqual(property.scope, ConfigurationScope.APPLICATION);
		const parser = new ConfigurationModelParser('workspace', new NullLogService());
		parser.parse(JSON.stringify({ [STUDIO_ADVANCED_MODE_CONFIG]: true }), { scopes: WORKSPACE_SCOPES });
		assert.strictEqual(parser.configurationModel.getValue(STUDIO_ADVANCED_MODE_CONFIG), undefined);
	});

	test('everyday features and capability management remain visible while professional entry points are folded', () => {
		for (const command of ['ai.chat.new', 'ai.settings', STUDIO_SETTINGS_COMMAND, 'aiStudio.capabilities.open', 'aiStudio.mcp.add', 'aiStudio.skills.import', 'workbench.command.new.skill', 'workbench.action.chat.configure.skills', 'editor.action.clipboardCopyAction', 'undo']) {
			assert.strictEqual(isStudioSimpleCommand(command), true, command);
		}
		for (const command of ['workbench.action.terminal.toggleTerminal', 'workbench.view.debug', 'workbench.view.extensions', 'workbench.action.openSettingsJson', 'workbench.action.openGlobalKeybindings', 'extension.professionalCommand']) {
			assert.strictEqual(isStudioSimpleMenuItem(MenuId.CommandPalette, { command: { id: command, title: command } }), false, command);
		}
		assert.strictEqual(isStudioSimpleMenuItem(MenuId.MenubarMainMenu, { submenu: MenuId.MenubarFileMenu, title: 'File' }), true);
		assert.strictEqual(isStudioSimpleMenuItem(MenuId.MenubarMainMenu, { submenu: MenuId.MenubarTerminalMenu, title: 'Terminal' }), false);
		assert.strictEqual(isStudioSimpleMenuItem(MenuId.EditorContext, { command: { id: 'editor.action.rename', title: 'Rename' } }), true);
	});

	test('professional default shortcuts route to friendly settings and restore immediately in advanced mode', () => {
		for (const os of [OperatingSystem.Macintosh, OperatingSystem.Windows, OperatingSystem.Linux]) {
			const rules = KeybindingsRegistry.getDefaultKeybindingsForOS(os).filter(item => item.command === STUDIO_SETTINGS_COMMAND && item.commandArgs === 'advanced');
			assert.strictEqual(rules.length, 7);
			for (const rule of rules) {
				assert.ok(rule.keybinding);
				const keybinding = USLayoutResolvedKeybinding.resolveKeybinding(rule.keybinding, os)[0];
				const original = new ResolvedKeybindingItem(keybinding, 'original.professionalCommand', undefined, undefined, true, null, false);
				const simple = new ResolvedKeybindingItem(keybinding, rule.command, rule.commandArgs, rule.when ?? undefined, true, null, false);
				const context = (advanced: boolean) => ({ getValue: <T>(key: string) => (key === STUDIO_ADVANCED_MODE_CONTEXT ? advanced : key === 'debugState' ? 'inactive' : undefined) as T | undefined });
				const resolver = new KeybindingResolver([original, simple], [], () => { });
				const result = resolver.resolve(context(false), [], simple.chords[0]);
				assert.ok(result.kind === ResultKind.KbFound);
				assert.strictEqual(result.commandId, STUDIO_SETTINGS_COMMAND);
				assert.strictEqual(result.commandArgs, 'advanced');
				const advancedResult = resolver.resolve(context(true), [], simple.chords[0]);
				assert.ok(advancedResult.kind === ResultKind.KbFound);
				assert.strictEqual(advancedResult.commandId, original.command);
				const userBinding = new ResolvedKeybindingItem(keybinding, 'user.preferredCommand', undefined, undefined, false, null, false);
				const userResult = new KeybindingResolver([original, simple], [userBinding], () => { }).resolve(context(false), [], simple.chords[0]);
				assert.ok(userResult.kind === ResultKind.KbFound);
				assert.strictEqual(userResult.commandId, userBinding.command);
			}
		}
	});
});
