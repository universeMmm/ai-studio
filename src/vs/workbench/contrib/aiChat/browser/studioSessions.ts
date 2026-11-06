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
import { safeIntl } from '../../../../base/common/date.js';
import { ActionListItemKind, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { isStudioAdvancedMode, STUDIO_ADVANCED_MODE_CONFIG } from '../../../common/studioMode.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatDetail, IChatService, ResponseModelState } from '../../chat/common/chatService/chatService.js';
import './media/studioNavigation.css';

const $ = dom.$;
const sessionTimeFormatter = safeIntl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const sessionDateFormatter = safeIntl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
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
	private readonly sessionCount: HTMLElement;
	private readonly rows = this._register(new DisposableStore());
	private sessions: IChatDetail[] = [];
	private revision = 0;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commands: ICommandService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@IEditorService private readonly editors: IEditorService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ILabelService labels: ILabelService,
		@IConfigurationService configuration: IConfigurationService,
		@IActionWidgetService actionWidget: IActionWidgetService,
	) {
		super();
		const root = dom.append(container, $('nav.studio-session-navigation.studio-navigation-v2', { 'aria-label': localize('studio.navigation', "项目与会话") }));
		const rail = dom.append(root, $('.studio-nav-rail', { 'aria-label': localize('studio.navigationTools', "工作区导航") }));
		const home = this.action(rail, Codicon.home, localize('studio.home', "会话主页"), 'aiStudio.home');
		home.classList.add('studio-rail-button', 'studio-rail-home');
		home.setAttribute('aria-current', 'page');
		const files = this.action(rail, Codicon.files, localize('studio.filesShort', "文件"), 'workbench.view.explorer');
		files.classList.add('studio-rail-button');
		const history = dom.append(rail, $('button.studio-nav-button.studio-rail-button', { type: 'button', title: localize('studio.searchHistory', "搜索聊天记录"), 'aria-label': localize('studio.searchHistory', "搜索聊天记录") }));
		dom.append(history, renderIcon(Codicon.history));
		const railCapabilities = this.action(rail, Codicon.extensions, localize('studio.capabilities', "技能与连接"), 'aiStudio.capabilities.open');
		railCapabilities.classList.add('studio-rail-button');
		dom.append(rail, $('.studio-rail-divider', { 'aria-hidden': 'true' }));
		const changes = this.action(rail, Codicon.gitCompare, localize('studio.changesShort', "变更"), 'aiStudio.openInspector', 'changes');
		changes.classList.add('studio-rail-button');
		const settings = this.action(rail, Codicon.settingsGear, localize('studio.settings', "设置"), 'aiStudio.settings.open');
		settings.classList.add('studio-rail-button', 'studio-rail-settings');
		const content = dom.append(root, $('.studio-nav-content'));
		const header = dom.append(content, $('.studio-nav-header'));
		const brand = dom.append(header, $('button.studio-nav-brand', { type: 'button', 'aria-label': localize('studio.appMenu', "AI Studio 菜单"), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }));
		dom.append(brand, $('span', undefined, 'AI Studio'), renderIcon(Codicon.chevronDown));
		this._register(toDisposable(() => {
			if (brand.getAttribute('aria-expanded') === 'true') { actionWidget.hide(); }
		}));
		const appActions: ReadonlyArray<{ label: string; icon: ThemeIcon; command: string; args?: unknown[] }> = [
			{ label: localize('studio.settings', "设置"), icon: Codicon.settingsGear, command: 'aiStudio.settings.open' },
			{ label: localize('studio.models', "模型设置"), icon: Codicon.sparkle, command: 'chat.modelConfiguration.open' },
			{ label: localize('studio.capabilities', "技能与连接"), icon: Codicon.extensions, command: 'aiStudio.capabilities.open' },
			{ label: localize('studio.appearance', "切换深浅色"), icon: Codicon.colorMode, command: 'aiStudio.theme.toggle' },
		];
		this._register(dom.addDisposableListener(brand, 'click', () => {
			if (brand.getAttribute('aria-expanded') === 'true') { actionWidget.hide(); return; }
			const items: IActionListItem<typeof appActions[number]>[] = appActions.map(item => ({
				kind: ActionListItemKind.Action, item, label: item.label,
				group: { title: '', icon: item.icon }, className: 'studio-navigation-menu-item',
			}));
			brand.setAttribute('aria-expanded', 'true');
			actionWidget.show('StudioNavigationMenu', false, items, {
				onSelect: action => {
					actionWidget.hide();
					void commands.executeCommand(action.command, ...(action.args ?? [])).catch(onUnexpectedError);
				},
				onHide: () => { brand.setAttribute('aria-expanded', 'false'); if (brand.isConnected) { brand.focus(); } },
			}, brand, undefined, [], { getAriaLabel: item => item.label ?? '', getWidgetAriaLabel: () => localize('studio.appMenu', "AI Studio 菜单"), getRole: () => 'menuitem', getWidgetRole: () => 'menu' },
				{ minWidth: 210, maxWidth: 260, actionItemHeight: 34, reserveSubmenuSpace: false, hideDefaultKeybindingTooltip: true });
		}));
		const searchToggle = dom.append(header, $('button.studio-nav-search-toggle', { type: 'button', title: localize('studio.searchSessions', "搜索会话"), 'aria-label': localize('studio.searchSessions', "搜索会话"), 'aria-expanded': 'false' }));
		dom.append(searchToggle, renderIcon(Codicon.search));
		const search = dom.append(content, $('.studio-nav-search', { hidden: true }));
		dom.append(search, renderIcon(Codicon.search));
		this.filter = dom.append(search, $('input.studio-nav-filter', { type: 'search', placeholder: localize('studio.searchSessionsPlaceholder', "搜索会话…"), 'aria-label': localize('studio.filterSessions', "筛选会话") }));
		const toggleSearch = (visible: boolean) => {
			search.hidden = !visible;
			searchToggle.setAttribute('aria-expanded', String(visible));
			if (visible) { this.filter.focus(); }
			else { this.filter.value = ''; this.draw(); searchToggle.focus(); }
		};
		this._register(dom.addDisposableListener(searchToggle, 'click', () => toggleSearch(search.hidden !== false)));
		this._register(dom.addDisposableListener(history, 'click', () => toggleSearch(true)));
		this._register(dom.addDisposableListener(this.filter, 'input', () => this.draw()));
		this._register(dom.addDisposableListener(this.filter, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (this.filter.value) { this.filter.value = ''; this.draw(); }
				else { toggleSearch(false); }
				e.preventDefault(); e.stopPropagation();
			}
		}));
		const primary = dom.append(content, $('.studio-nav-primary'));
		const create = this.action(primary, Codicon.edit, localize('studio.newChat', "新聊天"), 'ai.chat.new');
		create.classList.add('studio-new-button');
		this.action(primary, Codicon.extensions, localize('studio.capabilities', "技能与连接"), 'aiStudio.capabilities.open');
		const section = dom.append(content, $('.studio-nav-section'));
		dom.append(section, $('h2', undefined, localize('studio.projects', "项目")));
		this.sessionCount = dom.append(section, $('span.studio-session-count'));
		const addProject = this.action(section, Codicon.add, localize('studio.openProject', "打开项目"), 'workbench.action.files.openFolder');
		addProject.classList.add('studio-nav-icon-button');
		const project = dom.append(content, $('button.studio-project-switcher', { type: 'button', title: localize('studio.switchProject', "打开最近的项目"), 'aria-label': localize('studio.switchProject', "打开最近的项目") }));
		dom.append(project, renderIcon(Codicon.folderOpened));
		const projectName = dom.append(project, $('span.studio-project-name'));
		dom.append(project, renderIcon(Codicon.chevronDown));
		this._register(dom.addDisposableListener(project, 'click', () => commands.executeCommand('workbench.action.openRecent').catch(onUnexpectedError)));
		this.list = dom.append(content, $('.studio-session-list'));
		const footer = dom.append(content, $('.studio-nav-footer'));
		const workspaceStatus = dom.append(footer, $('.studio-workspace-status'));
		dom.append(workspaceStatus, renderIcon(Codicon.deviceDesktop));
		const workspaceLabel = dom.append(workspaceStatus, $('span', undefined, localize('studio.local', "本地")));
		const shortcuts = dom.append(footer, $('.studio-nav-shortcuts', { 'aria-label': localize('studio.projectTools', "项目工具") }));
		const terminal = this.action(shortcuts, Codicon.terminal, localize('studio.terminal', "终端"), 'workbench.action.terminal.toggleTerminal');
		terminal.classList.add('studio-nav-icon-button');
		const updateWorkspace = () => {
			const current = workspace.getWorkspace();
			const advanced = isStudioAdvancedMode(configuration);
			projectName.textContent = current.folders.length ? labels.getWorkspaceLabel(current) : localize('studio.noProject', "选择项目");
			projectName.title = projectName.textContent;
			workspaceLabel.title = current.folders.length === 1 ? labels.getUriLabel(current.folders[0].uri) : current.folders.length > 1 ? localize('studio.folderCount', "{0} 个文件夹", current.folders.length) : localize('studio.noWorkspace', "尚未选择项目");
			workspaceStatus.title = workspaceLabel.title;
			terminal.hidden = !advanced;
			root.classList.toggle('studio-navigation-basic', !advanced);
		};
		updateWorkspace();
		this._register(workspace.onDidChangeWorkspaceFolders(updateWorkspace));
		this._register(workspace.onDidChangeWorkspaceName(updateWorkspace));
		this._register(configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(STUDIO_ADVANCED_MODE_CONFIG)) { updateWorkspace(); }
		}));
		this._register(editors.onDidActiveEditorChange(() => this.refresh()));
		this._register(chatService.onDidSubmitRequest(() => this.refresh()));
		this._register(chatService.onDidDisposeSession(() => this.refresh()));
		this._register(autorun(reader => { chatService.requestInProgressObs.read(reader); this.refresh(); }));
	}

	private action(parent: HTMLElement, icon: ThemeIcon, title: string, command: string, ...args: unknown[]): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.studio-nav-button', { type: 'button', title, 'aria-label': title }));
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
		this.sessionCount.textContent = String(this.sessions.length);
		this.sessionCount.setAttribute('aria-label', localize('studio.sessionCount', "{0} 个会话", this.sessions.length));
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		for (const item of matches) {
			const isToday = item.lastMessageDate >= today.getTime();
			const key = item.sessionResource.toString();
			const button = dom.append(this.list, $('button.studio-session-row', { type: 'button', title: item.title, 'aria-current': String(key === current) }));
			button.dataset.session = key;
			const pending = item.lastResponseState === ResponseModelState.Pending && item.isActive;
			button.classList.toggle('studio-session-running', pending);
			const copy = dom.append(button, $('.studio-session-copy'));
			dom.append(copy, $('span.session-title', undefined, item.title));
			const timestamp = new Date(item.lastMessageDate);
			const date = Number.isFinite(timestamp.getTime()) ? (isToday ? sessionTimeFormatter : sessionDateFormatter).value.format(timestamp) : '';
			button.title = date ? `${item.title} · ${date}` : item.title;
			if (pending) { dom.append(button, renderIcon(ThemeIcon.modify(Codicon.loading, 'spin'))); }
			if (pending) { button.setAttribute('aria-label', localize('studio.runningSession', "{0}，正在执行", item.title)); }
			this.rows.add(dom.addDisposableListener(button, 'click', () => this.widgets.openSession(item.sessionResource, ACTIVE_GROUP, { pinned: true }).catch(onUnexpectedError)));
			if (key === focusedRow) { button.focus({ preventScroll: true }); }
		}
		if (!matches.length) {
			const empty = dom.append(this.list, $('.studio-session-empty'));
			empty.textContent = filter ? localize('studio.noMatches', "没有匹配的会话") : localize('studio.noChats', "暂无聊天");
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
