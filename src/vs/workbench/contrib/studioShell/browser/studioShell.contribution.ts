/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — desktop workspace defaults.
 *--------------------------------------------------------------------------------------------*/

import './media/studioShell.css';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.startupEditor': 'agentWorkspace',
		'workbench.colorTheme': 'Studio Light',
		'workbench.preferredDarkColorTheme': 'Studio Dark',
		'workbench.preferredLightColorTheme': 'Studio Light',
		'workbench.activityBar.location': 'top',
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.layoutControl.enabled': false,
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'workbench.welcomePage.experimentalOnboarding': false,
		'editor.minimap.enabled': false,
	}
}]);

class StudioWorkspace implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.studioWorkspace';

	constructor(
		@IEditorGroupsService groups: IEditorGroupsService,
		@IEditorService editors: IEditorService,
		@ICommandService commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
	) {
		layout.mainContainer.classList.add('studio-desktop');
		void groups.whenRestored.then(async () => {
			if (configuration.getValue('workbench.startupEditor') === 'agentWorkspace' && !editors.count) {
				await commands.executeCommand('ai.chat.open');
			}
		}).catch(onUnexpectedError);
	}
}

registerWorkbenchContribution2(StudioWorkspace.ID, StudioWorkspace, WorkbenchPhase.AfterRestored);
