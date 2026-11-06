/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IURLService } from '../../../../../platform/url/common/url.js';
import { DEFAULT_EDITOR_ASSOCIATION, isEditorInput, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IJSONEditingService } from '../../../configuration/common/jsonEditing.js';
import { TestJSONEditingService } from '../../../configuration/test/common/testServices.js';
import { IEditorService, PreferredGroup } from '../../../editor/common/editorService.js';
import { PreferencesService } from '../../browser/preferencesService.js';
import { IPreferencesService, ISettingsEditorOptions } from '../../common/preferences.js';
import { IRemoteAgentService } from '../../../remote/common/remoteAgentService.js';
import { TestRemoteAgentService, ITestInstantiationService, workbenchInstantiationService, TestEditorService } from '../../../../test/browser/workbenchTestServices.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { STUDIO_ADVANCED_MODE_CONFIG, STUDIO_SETTINGS_COMMAND } from '../../../../common/studioMode.js';

suite('PreferencesService', () => {
	let testInstantiationService: ITestInstantiationService;
	let testObject: PreferencesService;
	let lastOpenEditorOptions: IEditorOptions | undefined;
	let configurationService: TestConfigurationService;
	let studioSettingsSections: unknown[];
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		testInstantiationService = workbenchInstantiationService({}, disposables);
		lastOpenEditorOptions = undefined;
		studioSettingsSections = [];
		configurationService = new TestConfigurationService({ [STUDIO_ADVANCED_MODE_CONFIG]: true });
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		testInstantiationService.stub(IConfigurationService, configurationService);

		class TestPreferencesEditorService extends TestEditorService {
			override async openEditor(editor: EditorInput | IUntypedEditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, group?: PreferredGroup): Promise<undefined> {
				lastOpenEditorOptions = optionsOrGroup as IEditorOptions;
				// openEditor takes ownership of the input
				if (isEditorInput(editor)) {
					editor.dispose();
				}
				return undefined;
			}
		}

		testInstantiationService.stub(IEditorService, disposables.add(new TestPreferencesEditorService()));
		testInstantiationService.stub(IJSONEditingService, TestJSONEditingService);
		testInstantiationService.stub(IRemoteAgentService, TestRemoteAgentService);
		testInstantiationService.stub(ICommandService, {
			executeCommand: async <T>(id: string, section?: unknown): Promise<T> => {
				assert.strictEqual(id, STUDIO_SETTINGS_COMMAND);
				studioSettingsSections.push(section);
				return undefined as T;
			}
		});
		testInstantiationService.stub(IURLService, { registerHandler: () => { } });

		// PreferencesService creates a PreferencesEditorInput which depends on IPreferencesService, add the real one, not a stub
		const collection = new ServiceCollection();
		collection.set(IPreferencesService, new SyncDescriptor(PreferencesService));
		const instantiationService = disposables.add(testInstantiationService.createChild(collection));
		testObject = disposables.add(instantiationService.createInstance(PreferencesService));
	});
	test('options are preserved when calling openEditor', async () => {
		await testObject.openSettings({ jsonEditor: false, query: 'test query' });
		const options = lastOpenEditorOptions as ISettingsEditorOptions;
		assert.strictEqual(options.focusSearch, true);
		assert.strictEqual(options.override, DEFAULT_EDITOR_ASSOCIATION.id);
		assert.strictEqual(options.query, 'test query');
	});

	test('simple mode routes legacy settings and keybinding entry points before any file or workspace access', async () => {
		await configurationService.setUserConfiguration(STUDIO_ADVANCED_MODE_CONFIG, false);
		const openers = [
			() => testObject.openSettings({ jsonEditor: true }),
			() => testObject.openUserSettings(),
			() => testObject.openApplicationSettings(),
			() => testObject.openWorkspaceSettings(),
			() => testObject.openFolderSettings(),
			() => testObject.openRemoteSettings(),
			() => testObject.openRawDefaultSettings(),
			() => testObject.openRawUserSettings(),
			() => testObject.openPreferences(),
			() => testObject.openGlobalKeybindingSettings(true),
			() => testObject.openGlobalKeybindingSettings(false),
			() => testObject.openDefaultKeybindingsFile(),
		];
		for (const open of openers) {
			await open();
		}
		assert.strictEqual(studioSettingsSections.length, openers.length);
		assert.strictEqual(lastOpenEditorOptions, undefined);
	});

	test('simple settings preserve the requested friendly section and advanced mode restores the editor', async () => {
		await configurationService.setUserConfiguration(STUDIO_ADVANCED_MODE_CONFIG, false);
		await testObject.openUserSettings({ query: '@id:ai.commandApproval' });
		await testObject.openSettings({ revealSetting: { key: 'ai.modelId' } });
		await testObject.openSettings({ query: 'workbench.colorTheme' });
		assert.deepStrictEqual(studioSettingsSections, ['approval', 'models', 'appearance']);
		await configurationService.setUserConfiguration(STUDIO_ADVANCED_MODE_CONFIG, true);
		await testObject.openSettings({ jsonEditor: false, query: 'editor.fontSize' });
		assert.strictEqual((lastOpenEditorOptions as ISettingsEditorOptions).query, 'editor.fontSize');
		assert.strictEqual(studioSettingsSections.length, 3);
	});
});
