/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace sessions
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatDetail, IChatService, ResponseModelState } from '../../chat/common/chatService/chatService.js';

const $ = dom.$;
export const studioSessionsContainerId = 'workbench.view.aiStudioSessions';

class StudioSessionsView extends ViewPane {
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const navigation = this._register(this.instantiationService.createInstance(StudioSessionNavigation, container));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { navigation.refresh(); } }));
	}
}

class StudioSessionNavigation extends Disposable {
	private readonly list: HTMLElement;
	private readonly filter: HTMLInputElement;
	private readonly rows = this._register(new DisposableStore());
	private sessions: IChatDetail[] = [];
	private revision = 0;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commands: ICommandService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		const title = localize('studio.sessions', "会话");
		const root = dom.append(container, $('nav.studio-session-navigation', { 'aria-label': title }));
		this.action(root, Codicon.add, localize('studio.newSession', "新建会话"), 'ai.chat.new').classList.add('studio-new-button');
		this.action(root, Codicon.files, localize('studio.files', "工作区文件"), 'workbench.view.explorer');
		this.action(root, Codicon.diffMultiple, localize('studio.changes', "变更审查"), 'aiStudio.openInspector', 'changes');
		const section = dom.append(root, $('.studio-nav-section'));
		dom.append(section, $('h2', undefined, localize('studio.history', "会话记录")));
		const filterLabel = localize('studio.filterSessions', "筛选会话");
		const toggle = dom.append(section, $('button.studio-filter-toggle', { type: 'button', title: filterLabel, 'aria-label': filterLabel, 'aria-expanded': 'false' }));
		dom.append(toggle, renderIcon(Codicon.search));
		this.filter = dom.append(root, $('input.studio-nav-filter', { type: 'search', placeholder: filterLabel, 'aria-label': filterLabel }));
		this.filter.hidden = true;
		this._register(dom.addDisposableListener(toggle, 'click', () => {
			this.filter.hidden = !this.filter.hidden;
			toggle.setAttribute('aria-expanded', String(!this.filter.hidden));
			if (this.filter.hidden) { this.filter.value = ''; this.draw(); }
			else { this.filter.focus(); }
		}));
		this._register(dom.addDisposableListener(this.filter, 'input', () => this.draw()));
		this._register(dom.addDisposableListener(this.filter, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') { toggle.click(); toggle.focus(); }
		}));
		this.list = dom.append(root, $('.studio-session-list'));
		const footer = dom.append(root, $('.studio-nav-footer'));
		this.action(footer, Codicon.settingsGear, localize('studio.models', "模型设置"), 'chat.modelConfiguration.open');
		this._register(editors.onDidActiveEditorChange(() => this.refresh()));
		this._register(chatService.onDidSubmitRequest(() => this.refresh()));
		this._register(chatService.onDidDisposeSession(() => this.refresh()));
		this._register(autorun(reader => { chatService.requestInProgressObs.read(reader); this.refresh(); }));
	}

	private action(parent: HTMLElement, icon: ThemeIcon, title: string, command: string, ...args: unknown[]): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.studio-nav-button', { type: 'button', 'aria-label': title }));
		dom.append(button, renderIcon(icon), $('span', undefined, title));
		this._register(dom.addDisposableListener(button, 'click', () => this.commands.executeCommand(command, ...args).catch(onUnexpectedError)));
		return button;
	}

	refresh(): void {
		const revision = ++this.revision;
		this.chatService.getLocalSessionHistory().then(sessions => {
			if (revision !== this.revision || this._store.isDisposed) { return; }
			this.sessions = sessions.filter(item => {
				const model = this.chatService.getSession(item.sessionResource);
				return !model || model.getRequests().length > 0;
			}).sort((a, b) => b.lastMessageDate - a.lastMessageDate);
			this.draw();
		}).catch(onUnexpectedError);
	}

	private draw(): void {
		const active = this.editors.activeEditor;
		const current = active instanceof ChatEditorInput ? active.sessionResource?.toString() : undefined;
		const filter = this.filter.value.trim().toLocaleLowerCase();
		const focused = dom.getActiveElement();
		const focusedRow = dom.isHTMLElement(focused) && this.list.contains(focused) ? focused.dataset.session : undefined;
		this.rows.clear();
		dom.clearNode(this.list);
		const matches = this.sessions.filter(item => item.title.toLocaleLowerCase().includes(filter));
		for (const item of matches) {
			const key = item.sessionResource.toString();
			const button = dom.append(this.list, $('button.studio-session-row', { type: 'button', title: item.title, 'aria-current': String(key === current) }));
			button.dataset.session = key;
			const pending = item.lastResponseState === ResponseModelState.Pending && item.isActive;
			const icon = pending ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.comment;
			dom.append(button, renderIcon(icon), $('span.session-title', undefined, item.title));
			if (pending) { button.setAttribute('aria-label', localize('studio.runningSession', "{0}，正在执行", item.title)); }
			this.rows.add(dom.addDisposableListener(button, 'click', () => this.widgets.openSession(item.sessionResource, ACTIVE_GROUP, { pinned: true }).catch(onUnexpectedError)));
			if (key === focusedRow) { button.focus({ preventScroll: true }); }
		}
		if (!matches.length) {
			dom.append(this.list, $('p.studio-session-empty', undefined, filter ? localize('studio.noMatches', "没有匹配的会话") : localize('studio.noSessions', "发送第一条消息后，会话将显示在这里。")));
		}
	}
}

const title = localize2('studio.sessionNavigation', "会话");
const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: studioSessionsContainerId, title, icon: Codicon.commentDiscussion, order: 0,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [studioSessionsContainerId, { mergeViewWithContainerWhenSingleView: true }]),
}, ViewContainerLocation.Sidebar);
Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: 'aiStudio.sessions', name: title, ctorDescriptor: new SyncDescriptor(StudioSessionsView),
	canToggleVisibility: false, canMoveView: true,
}], container);
