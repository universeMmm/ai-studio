/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatWidget } from '../chat.js';
import { getStudioChatAddCapabilities, IStudioChatAddCapability } from './studioChatAddCapabilities.js';
import '../widget/media/studioChatAddMenu.css';

const openMenus = new WeakMap<HTMLElement, () => void>();

/** Reuse the native action list and attachment model, scoped to the Studio composer. */
export async function showStudioChatAddMenu(accessor: ServicesAccessor, widget: IChatWidget, searchFiles: () => Promise<void>): Promise<boolean> {
	// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
	const composer = widget.domNode.querySelector<HTMLElement>('.chat-input-container');
	if (!composer || !widget.domNode.closest('.studio-chat-editor')) {
		return false;
	}
	const existing = openMenus.get(composer);
	if (existing) {
		existing();
		return true;
	}
	const actions = accessor.get(IActionWidgetService);
	const dialogs = accessor.get(IFileDialogService);
	const files = accessor.get(IFileService);
	const notifications = accessor.get(INotificationService);
	const instantiation = accessor.get(IInstantiationService);
	const store = new DisposableStore();
	const cancellation = store.add(new CancellationTokenSource());
	const session = widget.viewModel?.sessionResource.toString();
	const isCurrent = () => composer.isConnected && widget.viewModel?.sessionResource.toString() === session;
	// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
	const anchor = () => composer.querySelector<HTMLElement>('.chat-input-toolbar .action-label.codicon-add');
	let shown = false;
	let restoreFocus = true;
	const close = () => { if (shown) { actions.hide(true); } else { cancellation.cancel(); } };
	const closeForLifecycle = () => { restoreFocus = false; close(); };
	openMenus.set(composer, close);
	store.add(widget.onDidHide(closeForLifecycle));
	store.add(widget.onDidChangeViewModel(closeForLifecycle));
	store.add(dom.addDisposableListener(dom.getWindow(composer), 'resize', close));
	const updateButton = () => {
		const button = anchor();
		button?.setAttribute('aria-haspopup', 'menu');
		button?.setAttribute('aria-expanded', String(shown));
	};
	const dispose = () => {
		shown = false;
		openMenus.delete(composer);
		updateButton();
		store.dispose();
	};
	try {
		const capabilities = await instantiation.invokeFunction(getStudioChatAddCapabilities, widget, cancellation.token);
		if (cancellation.token.isCancellationRequested || !isCurrent()) {
			dispose();
			return true;
		}
		const item = (action: Pick<IStudioChatAddCapability, 'id' | 'label' | 'description' | 'icon' | 'run'>): IActionListItem<typeof action> => ({
			kind: ActionListItemKind.Action, item: action, label: action.label, description: action.description,
			group: { title: '', icon: action.icon }, className: 'studio-add-menu-item',
		});
		const items = [
			{ kind: ActionListItemKind.Header, label: localize('studio.add.title', '添加') },
			item({
				id: 'studio.chat.add.files', label: localize('studio.add.files', '文件和文件夹'), icon: Codicon.attach,
				run: async () => {
					const selected = await dialogs.showOpenDialog({
						title: localize('studio.add.files', '文件和文件夹'),
						openLabel: localize('studio.add.attach', '添加'),
						defaultUri: await dialogs.defaultFilePath(),
						canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
					});
					for (const uri of selected ?? []) {
						if (!isCurrent()) { return; }
						try {
							const stat = await files.stat(uri);
							if (!isCurrent()) { return; }
							if (stat.isDirectory) { widget.attachmentModel.addFolder(uri); }
							else { await widget.attachmentModel.addFile(uri, undefined, isCurrent); }
						} catch (error) { notifications.error(error); }
					}
					if (isCurrent()) { widget.focusInput(); }
				},
			}),
			item({ id: 'studio.chat.searchFiles', label: localize('studio.add.search', '搜索项目文件'), description: localize('studio.add.search.description', '查找文件、符号和更多上下文'), icon: Codicon.search, run: searchFiles }),
			{ kind: ActionListItemKind.Header, label: localize('studio.add.skills', '技能') },
			...capabilities.filter(action => action.section === 'skills').map(item),
			{ kind: ActionListItemKind.Header, label: localize('studio.add.connections', '连接') },
			...capabilities.filter(action => action.section === 'mcp').map(item),
			{ kind: ActionListItemKind.Header, label: localize('studio.add.plugins', '插件') },
			...capabilities.filter(action => action.section === 'plugins').map(item),
		];
		const rect = dom.getDomNodePagePosition(composer);
		const width = Math.max(160, Math.min(360, rect.width - 18, dom.getWindow(composer).innerWidth - 40));
		shown = true;
		updateButton();
		// Menu updates replace action items. Keep state on the composer and restore
		// focus to its current button, never to a disposed toolbar view item.
		const observer = new (dom.getWindow(composer).MutationObserver)(updateButton);
		observer.observe(composer, { childList: true, subtree: true });
		store.add({ dispose: () => observer.disconnect() });
		actions.show('StudioChatAdd', false, items, {
			onSelect: action => {
				actions.hide();
				if (isCurrent()) { void action.run().catch(error => notifications.error(error)); }
			},
			onHide: () => {
				dispose();
				if (restoreFocus && isCurrent()) { anchor()?.focus(); }
			},
		}, { x: rect.left, y: rect.top - 8, width: rect.width, height: 1 }, undefined, [], {
			getWidgetAriaLabel: () => localize('studio.add.menu', '添加附件、技能和插件'),
			getWidgetRole: () => 'menu',
			getRole: entry => entry.kind === ActionListItemKind.Action ? 'menuitem' : 'separator',
			getAriaLabel: entry => entry.label ?? '',
		}, {
			anchorPosition: AnchorPosition.ABOVE,
			minWidth: width, maxWidth: width, actionItemHeight: 36,
			inlineDescription: true, reserveSubmenuSpace: false, hideDefaultKeybindingTooltip: true,
		});
		return true;
	} catch (error) {
		dispose();
		throw error;
	}
}
