/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EnablementState, IWorkbenchExtensionEnablementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';

const LANGUAGE_MODELS_ENTITLEMENT_PRECONDITION = ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.or(
	ChatContextKeys.Entitlement.planFree,
	ChatContextKeys.Entitlement.planEdu,
	ChatContextKeys.Entitlement.planPro,
	ChatContextKeys.Entitlement.planProPlus,
	ChatContextKeys.Entitlement.planMax,
	ChatContextKeys.Entitlement.planBusiness,
	ChatContextKeys.Entitlement.planEnterprise,
	ChatContextKeys.Entitlement.internal,
	ChatEntitlementContextKeys.clientByokEnabled
));

// AI Studio: ModelsManagementEditor registration disabled in favor of modelConfiguration.
// Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
// 	EditorPaneDescriptor.create(
// 		ModelsManagementEditor,
// 		ModelsManagementEditor.ID,
// 		localize('modelsManagementEditor', "Models Management Editor")
// 	),
// 	[
// 		new SyncDescriptor(ModelsManagementEditorInput)
// 	]
// );

// class ModelsManagementEditorInputSerializer implements IEditorSerializer {

// 	canSerialize(editorInput: EditorInput): boolean {
// 		return true;
// 	}

// 	serialize(input: ModelsManagementEditorInput): string {
// 		return '';
// 	}

// 	deserialize(instantiationService: IInstantiationService): ModelsManagementEditorInput {
// 		return instantiationService.createInstance(ModelsManagementEditorInput);
// 	}
// }

// Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ModelsManagementEditorInput.ID, ModelsManagementEditorInputSerializer);

/**
 * Enable + activate the AI Studio Chat extension if installed but disabled.
 */
async function ensureChatExtensionEnabled(accessor: ServicesAccessor): Promise<void> {
	const chatExtensionId = accessor.get(IProductService).defaultChatAgent?.chatExtensionId;
	if (!chatExtensionId) {
		return;
	}

	const extensionsWorkbenchService = accessor.get(IExtensionsWorkbenchService);
	const extensionEnablementService = accessor.get(IWorkbenchExtensionEnablementService);
	const progressService = accessor.get(IProgressService);

	const localExtensions = await extensionsWorkbenchService.queryLocal();
	const chatExtension = localExtensions.find(e => ExtensionIdentifier.equals(e.identifier.id, chatExtensionId));
	if (!chatExtension?.local || extensionEnablementService.isEnabled(chatExtension.local)) {
		return;
	}

	await progressService.withProgress(
		{ location: ProgressLocation.Window, title: localize('enableChatForByok', "Enabling AI features…") },
		async () => {
			await extensionsWorkbenchService.setEnablement([chatExtension], EnablementState.EnabledGlobally);
			await extensionsWorkbenchService.updateRunningExtensions(localize('enableChatForByokReason', "Enabling AI features"));
		}
	);
}

class ChatManagementActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatManagementActions';

	constructor(
	) {
		super();
		this.registerChatManagementActions();
	}

	private registerChatManagementActions() {
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: MANAGE_CHAT_COMMAND_ID,
					title: localize2('openAiManagement', "模型配置"),
					category: CHAT_CATEGORY,
					precondition: LANGUAGE_MODELS_ENTITLEMENT_PRECONDITION,
					f1: true,
				});
			}
			async run(accessor: ServicesAccessor) {
				const commandService = accessor.get(ICommandService);
				await ensureChatExtensionEnabled(accessor);
				return commandService.executeCommand('chat.modelConfiguration.open');
			}
		}));

		// AI Studio: ModelsManagementEditor and its actions are replaced by modelConfiguration.
		// The clear search, JSON editor, and editor title actions are no longer needed.

		// this._register(registerAction2(class extends Action2 {
		// 	constructor() {
		// 		super({
		// 			id: 'chat.models.action.clearSearchResults',
		// 			precondition: CONTEXT_MODELS_EDITOR,
		// 			keybinding: {
		// 				primary: KeyCode.Escape,
		// 				weight: KeybindingWeight.EditorContrib,
		// 				when: CONTEXT_MODELS_SEARCH_FOCUS
		// 			},
		// 			title: localize2('models.clearResults', "Clear Models Search Results")
		// 		});
		// 	}

		// 	run(accessor: ServicesAccessor) {
		// 		const activeEditorPane = accessor.get(IEditorService).activeEditorPane;
		// 		if (activeEditorPane instanceof ModelsManagementEditor) {
		// 			activeEditorPane.clearSearch();
		// 		}
		// 		return null;
		// 	}
		// }));

		// const openLanguageModelsJsonWhen = ContextKeyExpr.and(
		// 	CONTEXT_MODELS_EDITOR,
		// 	LANGUAGE_MODELS_ENTITLEMENT_PRECONDITION
		// );
		// this._register(registerAction2(class extends Action2 {
		// 	constructor() {
		// 		super({
		// 			id: 'workbench.action.openLanguageModelsJson',
		// 			title: localize2('openLanguageModelsJson', "Open Language Models (JSON)"),
		// 			category: CHAT_CATEGORY,
		// 			precondition: LANGUAGE_MODELS_ENTITLEMENT_PRECONDITION,
		// 			icon: languageModelsOpenSettingsIcon,
		// 			f1: true,
		// 			menu: [{
		// 				id: MenuId.EditorTitle,
		// 				when: openLanguageModelsJsonWhen,
		// 				group: 'navigation',
		// 				order: 1
		// 			}, {
		// 				id: MenuId.ModalEditorEditorTitle,
		// 				when: openLanguageModelsJsonWhen,
		// 				group: 'navigation',
		// 				order: 1
		// 			}]
		// 		});
		// 	}

		// 	async run(accessor: ServicesAccessor) {
		// 		const languageModelsConfigurationService = accessor.get(ILanguageModelsConfigurationService);
		// 		await languageModelsConfigurationService.configureLanguageModels();
		// 	}
		// }));
	}

}

registerWorkbenchContribution2(ChatManagementActionsContribution.ID, ChatManagementActionsContribution, WorkbenchPhase.AfterRestored);
