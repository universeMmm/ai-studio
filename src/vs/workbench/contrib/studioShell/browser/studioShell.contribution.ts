/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — desktop workspace defaults.
 *--------------------------------------------------------------------------------------------*/

import './media/studioShell.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isStudioAdvancedMode, STUDIO_ADVANCED_MODE_CONFIG } from '../../../common/studioMode.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { studioSessionsContainerId } from '../../aiChat/browser/studioSessions.js';

const advancedLayoutStorageKey = 'studio.advancedLayout.v1';
const basicModeOverrides: ReadonlyArray<readonly [string, unknown]> = [
	['workbench.activityBar.location', 'hidden'],
	['workbench.statusBar.visible', false],
	['window.commandCenter', false],
	['workbench.layoutControl.enabled', false],
];

interface StudioAdvancedLayout {
	sidebarVisible: boolean;
	sidebarId?: string;
	sidebarWidth?: number;
	panelVisible: boolean;
	panelId?: string;
	panelMaximized: boolean;
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.startupEditor': 'agentWorkspace',
		'workbench.colorTheme': 'Studio Light',
		'workbench.preferredDarkColorTheme': 'Studio Dark',
		'workbench.preferredLightColorTheme': 'Studio Light',
		'workbench.activityBar.location': 'default',
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.layoutControl.enabled': false,
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'workbench.welcomePage.experimentalOnboarding': false,
		'editor.minimap.enabled': false,
	}
}]);

class StudioWorkspace extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.studioWorkspace';
	private readonly containerDisposables = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly editorOptions = this._register(new DisposableMap<IEditorPart, DisposableStore>());
	private readonly previousMemoryValues = new Map<string, unknown>();
	private appliedAdvancedMode: boolean | undefined;
	private modeChanges: Promise<void> = Promise.resolve();
	private themeChange: Promise<void> | undefined;
	private responsiveSidebarNarrow = false;
	private responsiveSidebarAutoHidden = false;
	private responsiveSidebarUpdating = false;
	private responsiveSidebarScheduled = false;

	constructor(
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IEditorService editors: IEditorService,
		@ICommandService commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IWorkbenchThemeService private readonly themes: IWorkbenchThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand('aiStudio.home', async () => {
			await this.panes.openPaneComposite(studioSessionsContainerId, ViewContainerLocation.Sidebar, false);
			await commands.executeCommand('ai.chat.open');
		}));
		this._register(CommandsRegistry.registerCommand('aiStudio.theme.toggle', () => this.toggleTheme()));
		for (const container of layout.containers) {
			this.installTitlebarActions(container, layout, commands);
		}
		this._register(layout.onDidAddContainer(({ container, disposables }) => {
			this.installTitlebarActions(container, layout, commands);
			disposables.add(toDisposable(() => this.containerDisposables.deleteAndDispose(container)));
		}));
		this._register(dom.onWillUnregisterWindow(window => {
			// Also cover auxiliary windows restored before this contribution started.
			for (const container of this.containerDisposables.keys()) {
				if (container.ownerDocument.defaultView === window) {
					this.containerDisposables.deleteAndDispose(container);
				}
			}
		}));
		this._register(groups.onDidCreateAuxiliaryEditorPart(part => {
			if (!isStudioAdvancedMode(configuration)) { this.simplifyEditorActions(part); }
		}));
		this._register(layout.onDidLayoutMainContainer(() => this.scheduleResponsiveSidebar()));
		this._register(layout.onDidChangePartVisibility(event => {
			if (event.partId === Parts.SIDEBAR_PART && !this.responsiveSidebarUpdating && !event.visible) {
				// A later explicit hide belongs to the user, not to the resize rule.
				this.responsiveSidebarAutoHidden = false;
			}
		}));
		this.modeChanges = Promise.all([groups.whenRestored, layout.whenRestored]).then(() => this.updateMode());
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(STUDIO_ADVANCED_MODE_CONFIG)) {
				this.modeChanges = this.modeChanges.catch(onUnexpectedError).then(() => this.updateMode());
				void this.modeChanges.catch(onUnexpectedError);
			}
		}));
		void this.modeChanges.then(async () => {
			// Give the redesigned navigation a compact starting width once, then preserve
			// the user's subsequent splitter adjustments in the normal workbench layout.
			if (!isStudioAdvancedMode(configuration) && !storage.getBoolean('studio.layout.v4', StorageScope.WORKSPACE, false) && layout.mainContainer.clientWidth >= 1000) {
				const size = layout.getSize(Parts.SIDEBAR_PART);
				layout.setSize(Parts.SIDEBAR_PART, { width: 340, height: size.height });
				this.syncTitlebarSidebarWidth();
				storage.store('studio.layout.v4', true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			if (configuration.getValue('workbench.startupEditor') === 'agentWorkspace' && !editors.count) {
				await commands.executeCommand('ai.chat.open');
			}
		}).catch(onUnexpectedError);
	}

	private async updateMode(): Promise<void> {
		if (this._store.isDisposed) { return; }
		const advanced = isStudioAdvancedMode(this.configuration);
		if (advanced === this.appliedAdvancedMode) { return; }
		this.responsiveSidebarNarrow = false;
		this.responsiveSidebarAutoHidden = false;
		for (const container of this.layout.containers) {
			container.classList.toggle('studio-basic', !advanced);
			container.classList.toggle('studio-advanced', advanced);
		}
		if (advanced) {
			for (const [key, value] of this.previousMemoryValues) {
				await this.configuration.updateValue(key, value, ConfigurationTarget.MEMORY);
			}
			this.previousMemoryValues.clear();
			this.editorOptions.clearAndDisposeAll();
			await this.restoreAdvancedLayout();
		} else {
			// Keep this snapshot across a restart in basic mode. It describes the user's
			// advanced layout, not the temporary layout that basic mode is about to show.
			if (!this.storage.get(advancedLayoutStorageKey, StorageScope.WORKSPACE)) {
				const snapshot: StudioAdvancedLayout = {
					sidebarVisible: this.layout.isVisible(Parts.SIDEBAR_PART),
					sidebarId: this.panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() ?? this.panes.getLastActivePaneCompositeId(ViewContainerLocation.Sidebar),
					sidebarWidth: this.layout.isVisible(Parts.SIDEBAR_PART) ? this.layout.getSize(Parts.SIDEBAR_PART).width : undefined,
					panelVisible: this.layout.isVisible(Parts.PANEL_PART),
					panelId: this.panes.getActivePaneComposite(ViewContainerLocation.Panel)?.getId() ?? this.panes.getLastActivePaneCompositeId(ViewContainerLocation.Panel),
					panelMaximized: this.layout.isPanelMaximized(),
				};
				this.storage.store(advancedLayoutStorageKey, snapshot, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			for (const [key, value] of basicModeOverrides) {
				if (!this.previousMemoryValues.has(key)) {
					this.previousMemoryValues.set(key, this.configuration.inspect(key).memoryValue);
				}
				await this.configuration.updateValue(key, value, ConfigurationTarget.MEMORY);
			}
			for (const part of this.groups.parts) { this.simplifyEditorActions(part); }
			// Hiding a panel preserves terminal processes, output, and editor inputs.
			this.layout.setPartHidden(true, Parts.PANEL_PART);
			await this.panes.openPaneComposite(studioSessionsContainerId, ViewContainerLocation.Sidebar, false);
		}
		this.appliedAdvancedMode = advanced;
		this.scheduleResponsiveSidebar();
	}

	private scheduleResponsiveSidebar(): void {
		if (this._store.isDisposed || this.responsiveSidebarUpdating || this.responsiveSidebarScheduled) { return; }
		this.responsiveSidebarScheduled = true;
		queueMicrotask(() => {
			this.responsiveSidebarScheduled = false;
			if (this._store.isDisposed || this.appliedAdvancedMode !== false || isStudioAdvancedMode(this.configuration)) { return; }
			this.updateResponsiveSidebar();
		});
	}

	private updateResponsiveSidebar(): void {
		const width = this.layout.mainContainerDimension.width;
		if (width <= 0) { return; }
		this.responsiveSidebarUpdating = true;
		try {
			if (width < 760 && !this.responsiveSidebarNarrow) {
				// Collapse once on entry. Opening the sidebar manually while narrow is
				// allowed, and ordinary layout events must not close it again.
				this.responsiveSidebarNarrow = true;
				this.responsiveSidebarAutoHidden = this.layout.isVisible(Parts.SIDEBAR_PART);
				if (this.responsiveSidebarAutoHidden) { this.layout.setPartHidden(true, Parts.SIDEBAR_PART); }
			} else if (width >= 900) {
				const restoreSidebar = this.responsiveSidebarAutoHidden;
				this.responsiveSidebarNarrow = false;
				this.responsiveSidebarAutoHidden = false;
				if (restoreSidebar) { this.layout.setPartHidden(false, Parts.SIDEBAR_PART); }
				// A profile first opened in a narrow window receives the same initial
				// width once enough space is available. Subsequent manual widths persist.
				if (!this.storage.getBoolean('studio.layout.v4', StorageScope.WORKSPACE, false)) {
					this.layout.setSize(Parts.SIDEBAR_PART, { width: 340, height: this.layout.getSize(Parts.SIDEBAR_PART).height });
					this.syncTitlebarSidebarWidth();
					this.storage.store('studio.layout.v4', true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				}
			}
		} finally {
			this.responsiveSidebarUpdating = false;
		}
	}

	private simplifyEditorActions(part: IEditorPart): void {
		if (this.editorOptions.has(part)) { return; }
		const disposables = new DisposableStore();
		this.editorOptions.set(part, disposables);
		// The conversation list is the primary navigation in basic mode. Keep every
		// open editor (including unsaved files), but let the editor part itself remove
		// the tab strip so its content receives the correct full-height layout.
		disposables.add(part.enforcePartOptions({ editorActionsLocation: 'hidden', showTabs: 'none' }));
		disposables.add(part.onWillDispose(() => this.editorOptions.deleteAndDispose(part)));
	}

	private async restoreAdvancedLayout(): Promise<void> {
		const snapshot = this.storage.getObject<StudioAdvancedLayout>(advancedLayoutStorageKey, StorageScope.WORKSPACE);
		if (!snapshot) { return; }
		if (snapshot.sidebarVisible && snapshot.sidebarId) {
			await this.panes.openPaneComposite(snapshot.sidebarId, ViewContainerLocation.Sidebar, false);
		}
		this.layout.setPartHidden(!snapshot.sidebarVisible, Parts.SIDEBAR_PART);
		if (snapshot.sidebarVisible && typeof snapshot.sidebarWidth === 'number' && snapshot.sidebarWidth > 0) {
			this.layout.setSize(Parts.SIDEBAR_PART, { width: snapshot.sidebarWidth, height: this.layout.getSize(Parts.SIDEBAR_PART).height });
			this.syncTitlebarSidebarWidth();
		}
		if (snapshot.panelVisible && snapshot.panelId) {
			await this.panes.openPaneComposite(snapshot.panelId, ViewContainerLocation.Panel, false);
		}
		this.layout.setPartHidden(!snapshot.panelVisible, Parts.PANEL_PART);
		if (snapshot.panelVisible && snapshot.panelMaximized !== this.layout.isPanelMaximized()) {
			this.layout.toggleMaximizedPanel();
		}
		this.storage.remove(advancedLayoutStorageKey, StorageScope.WORKSPACE);
	}

	private syncTitlebarSidebarWidth(): void {
		if (this._store.isDisposed) { return; }
		const width = this.layout.isVisible(Parts.SIDEBAR_PART) ? this.layout.getSize(Parts.SIDEBAR_PART).width : 0;
		const value = `${width}px`;
		for (const container of this.containerDisposables.keys()) {
			if (container.style.getPropertyValue('--studio-sidebar-width') !== value) {
				container.style.setProperty('--studio-sidebar-width', value);
			}
		}
	}

	private installTitlebarActions(container: HTMLElement, layout: IWorkbenchLayoutService, commands: ICommandService): void {
		if (this.containerDisposables.has(container)) { return; }
		const disposables = new DisposableStore();
		this.containerDisposables.set(container, disposables);
		container.classList.add('studio-desktop');
		container.classList.toggle('studio-basic', !isStudioAdvancedMode(this.configuration));
		container.classList.toggle('studio-advanced', isStudioAdvancedMode(this.configuration));
		let sidebarWidthSyncQueued = false;
		const scheduleSidebarWidthSync = () => {
			if (sidebarWidthSyncQueued || disposables.isDisposed) { return; }
			sidebarWidthSyncQueued = true;
			queueMicrotask(() => {
				sidebarWidthSyncQueued = false;
				if (!disposables.isDisposed) { this.syncTitlebarSidebarWidth(); }
			});
		};
		this.syncTitlebarSidebarWidth();
		disposables.add(layout.onDidLayoutContainer(scheduleSidebarWidthSync));
		disposables.add(layout.onDidChangePartVisibility(scheduleSidebarWidthSync));
		// Grid resizing (including a sash drag or setSize) does not emit a window
		// layout event. Observe the real sidebar so the header follows those changes
		// too. The callback only updates titlebar CSS, never the observed sidebar.
		const sidebar = layout.getContainer(dom.getWindow(layout.mainContainer), Parts.SIDEBAR_PART);
		if (sidebar) {
			const observer = disposables.add(new dom.DisposableResizeObserver('StudioWorkspace.sidebarWidth', scheduleSidebarWidthSync, dom.getWindow(sidebar)));
			disposables.add(observer.observe(sidebar));
		}
		const group = dom.$('div.studio-theme-switch');
		// One stable action button: the icon shows the current theme and its name
		// describes the next action, so it deliberately has no toggle-button state.
		const button = dom.append(group, dom.$<HTMLButtonElement>('button.studio-theme-button', { type: 'button' }));
		let switching = false;
		const update = () => {
			const dark = isDark(this.themes.getColorTheme().type);
			container.classList.toggle('studio-dark', dark);
			container.classList.toggle('studio-light', !dark);
			button.dataset.theme = dark ? 'dark' : 'light';
			button.dataset.targetTheme = dark ? 'light' : 'dark';
			button.title = dark
				? localize('studio.switchToLight', "当前为深色模式，切换到浅色模式")
				: localize('studio.switchToDark', "当前为浅色模式，切换到深色模式");
			button.setAttribute('aria-label', button.title);
			dom.reset(button, renderIcon(dark ? Codicon.colorMode : Codicon.lightbulb));
		};
		disposables.add(dom.addDisposableListener(button, 'click', () => {
			if (switching) { return; }
			switching = true;
			// Keep keyboard focus on the same control during an asynchronous switch.
			button.setAttribute('aria-busy', 'true');
			void commands.executeCommand('aiStudio.theme.toggle').catch(onUnexpectedError).finally(() => {
				switching = false;
				button.removeAttribute('aria-busy');
			});
		}));
		const settings = dom.append(group, dom.$<HTMLButtonElement>('button.studio-settings-button', {
			type: 'button', title: localize('studio.settings', "设置"), 'aria-label': localize('studio.settings', "设置")
		}));
		dom.append(settings, renderIcon(Codicon.settingsGear), dom.$('span.studio-settings-label', undefined, localize('studio.settings', "设置")));
		disposables.add(dom.addDisposableListener(settings, 'click', () => commands.executeCommand('aiStudio.settings.open').catch(onUnexpectedError)));
		update();
		disposables.add(this.themes.onDidColorThemeChange(update));
		disposables.add(toDisposable(() => {
			group.remove();
			container.style.removeProperty('--studio-sidebar-width');
			container.classList.remove('studio-desktop', 'studio-dark', 'studio-light', 'studio-basic', 'studio-advanced');
		}));
		const attach = () => {
			// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
			const titlebar = container.querySelector<HTMLElement>('.part.titlebar .titlebar-right');
			if (!titlebar) { return false; }
			titlebar.prepend(group);
			return true;
		};
		// Auxiliary containers are announced before their titlebar is created.
		// Their first layout runs after the editor and titlebar have been assembled.
		if (!attach()) {
			const pendingAttachment = disposables.add(new MutableDisposable());
			pendingAttachment.value = layout.onDidLayoutContainer(event => {
				if (event.container === container && attach()) {
					pendingAttachment.clear();
				}
			});
		}
	}

	private toggleTheme(): Promise<void> {
		if (!this.themeChange) {
			this.themeChange = this.selectTheme(!isDark(this.themes.getColorTheme().type)).finally(() => { this.themeChange = undefined; });
		}
		return this.themeChange;
	}

	private async selectTheme(dark: boolean): Promise<void> {
		const settingsId = dark ? 'Studio Dark' : 'Studio Light';
		const theme = (await this.themes.getColorThemes()).find(theme => theme.settingsId === settingsId);
		if (!theme) { throw new Error(`Theme is unavailable: ${settingsId}`); }
		// An explicit switch is a user preference, not a preview or an OS-mode override.
		if (this.configuration.getValue<boolean>('window.autoDetectColorScheme')) {
			await this.configuration.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
		}
		await this.themes.setColorTheme(theme.id, ConfigurationTarget.USER);
	}
}

registerWorkbenchContribution2(StudioWorkspace.ID, StudioWorkspace, WorkbenchPhase.AfterRestored);
