/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ACTIVE_GROUP, AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { isChatViewTitleActionContext } from '../../common/actions/chatActions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { ChatViewId, IChatWidgetService, isIChatViewViewContext } from '../chat.js';
import { IChatEditorOptions } from '../widgetHosts/editor/chatEditor.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';
import { CHAT_CATEGORY } from './chatActions.js';

enum MoveToNewLocation {
	Editor = 'Editor',
	Window = 'Window'
}

export function registerMoveActions() {
	registerAction2(class GlobalMoveToEditorAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.openInEditor',
				title: localize2('chat.openInEditor.label', "Move Chat into Editor Area"),
				category: CHAT_CATEGORY,
				precondition: ChatContextKeys.enabled,
				f1: true,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', ChatViewId),
					order: 0,
					group: '1_open'
				},
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]) {
			const context = args[0];
			executeMoveToAction(accessor, MoveToNewLocation.Editor, isChatViewTitleActionContext(context) ? context.sessionResource : undefined);
		}
	});

	registerAction2(class GlobalMoveToNewWindowAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.openInNewWindow',
				title: localize2('chat.openInNewWindow.label', "Move Chat into New Window"),
				category: CHAT_CATEGORY,
				precondition: ChatContextKeys.enabled,
				f1: true,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', ChatViewId),
					order: 0,
					group: '1_open'
				},
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]) {
			const context = args[0];
			executeMoveToAction(accessor, MoveToNewLocation.Window, isChatViewTitleActionContext(context) ? context.sessionResource : undefined);
		}
	});

	// Compatibility for old keybindings and extension commands. A second sidebar
	// host is no longer offered in Studio, and the current editor must stay open.
	registerAction2(class GlobalMoveToSidebarAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.openInSidebar',
				title: localize2('interactiveSession.openInSidebar.label', "Move Chat into Side Bar"),
				category: CHAT_CATEGORY,
				precondition: ChatContextKeys.enabled,
			});
		}

		async run(accessor: ServicesAccessor) {
			(await accessor.get(IChatWidgetService).revealWidget())?.focusInput();
		}
	});
}

async function executeMoveToAction(accessor: ServicesAccessor, moveTo: MoveToNewLocation, sessionResource?: URI) {
	const widgetService = accessor.get(IChatWidgetService);

	const auxiliary = { compact: true, bounds: { width: 800, height: 640 } };

	const widget = (sessionResource ? widgetService.getWidgetBySessionResource(sessionResource) : undefined)
		?? widgetService.lastFocusedWidget;
	if (!widget || !widget.viewModel || widget.location !== ChatAgentLocation.Chat) {
		await widgetService.openSession(ChatEditorInput.getNewEditorUri(), moveTo === MoveToNewLocation.Window ? AUX_WINDOW_GROUP : ACTIVE_GROUP, { pinned: true, auxiliary });
		return;
	}

	if (moveTo === MoveToNewLocation.Editor && !isIChatViewViewContext(widget.viewContext) && await widgetService.reveal(widget)) {
		widget.focusInput();
		return;
	}

	const existingWidget = widgetService.getWidgetBySessionResource(widget.viewModel.sessionResource);
	if (!existingWidget) {
		// Do NOT attempt to open a session that isn't already open since we cannot guarantee its state.
		await widgetService.openSession(ChatEditorInput.getNewEditorUri(), moveTo === MoveToNewLocation.Window ? AUX_WINDOW_GROUP : ACTIVE_GROUP, { pinned: true, auxiliary });
		return;
	}

	// Save off the session resource before clearing
	const resourceToOpen = widget.viewModel.sessionResource;

	// Todo: can possibly go away with https://github.com/microsoft/vscode/pull/278476
	const modelInputState = existingWidget.getViewState();

	await widget.clear();

	const options: IChatEditorOptions = { pinned: true, modelInputState, auxiliary };
	await widgetService.openSession(resourceToOpen, moveTo === MoveToNewLocation.Window ? AUX_WINDOW_GROUP : ACTIVE_GROUP, options);
}
