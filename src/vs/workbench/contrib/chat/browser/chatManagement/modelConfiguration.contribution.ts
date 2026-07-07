/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { ModelConfigurationEditor, MODEL_CONFIGURATION_EDITOR_ID } from './modelConfigurationEditor.js';
import { ModelConfigurationEditorInput, MODEL_CONFIGURATION_EDITOR_INPUT_ID } from './modelConfigurationEditorInput.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';
import { CustomModelProvider, registerCustomModelProvider } from './customModelProvider.js';

//#region Editor Registration

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ModelConfigurationEditor,
		MODEL_CONFIGURATION_EDITOR_ID,
		localize('modelConfigurationEditor', "Model Configuration Editor")
	),
	[
		new SyncDescriptor(ModelConfigurationEditorInput)
	]
);

//#endregion

//#region Editor Serializer

class ModelConfigurationEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof ModelConfigurationEditorInput;
	}

	serialize(input: ModelConfigurationEditorInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): ModelConfigurationEditorInput {
		return ModelConfigurationEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	MODEL_CONFIGURATION_EDITOR_INPUT_ID,
	ModelConfigurationEditorInputSerializer
);

//#endregion

//#region Actions

class ModelConfigurationActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.modelConfigurationActions';

	constructor() {
		super();
		this.registerActions();
	}

	private registerActions(): void {
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'chat.modelConfiguration.open',
					title: localize2('openModelConfiguration', "模型配置"),
					category: CHAT_CATEGORY,
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const editorService = accessor.get(IEditorService);
				const input = ModelConfigurationEditorInput.getOrCreate();
				await editorService.openEditor(input, { pinned: true });
			}
		}));
	}
}

registerWorkbenchContribution2(
	ModelConfigurationActionsContribution.ID,
	ModelConfigurationActionsContribution,
	WorkbenchPhase.AfterRestored
);

//#endregion

//#region Custom Model Provider Registration

class CustomModelProviderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.customModelProvider';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService languageModelsConfigurationService: ILanguageModelsConfigurationService,
	) {
		super();
		try {
			const provider = new CustomModelProvider(languageModelsConfigurationService);
			this._register(provider);
			this._register(registerCustomModelProvider(languageModelsService, provider));
		} catch (err) {
			// Non-fatal: editor still works even if provider registration fails
		}
	}
}

registerWorkbenchContribution2(
	CustomModelProviderContribution.ID,
	CustomModelProviderContribution,
	WorkbenchPhase.AfterRestored
);

//#endregion
