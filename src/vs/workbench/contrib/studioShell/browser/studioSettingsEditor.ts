/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/studioSettings.css';
import * as dom from '../../../../base/browser/dom.js';
import { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { getUserAIConfiguration } from '../../../../platform/ai/common/aiSecurityConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { isStudioAdvancedMode, STUDIO_ADVANCED_MODE_CONFIG } from '../../../common/studioMode.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { StudioSettingsEditorInput } from './studioSettingsEditorInput.js';

export const STUDIO_SETTINGS_EDITOR_ID = 'workbench.editor.studioSettings';
export interface IStudioSettingsOptions extends IEditorOptions { readonly section?: string }

const approvalModes = ['unsafe', 'all', 'none'] as const;
const approvalLabels = [localize('studio.settings.approval.unsafe', '按需审批'), localize('studio.settings.approval.all', '逐条审批'), localize('studio.settings.approval.none', '自动执行')];
const approvalDescriptions = [
	localize('studio.settings.approval.unsafeDescription', '仅 pwd 和简单 echo 在只读沙箱中自动运行；Git、包管理器等外部命令先征求你的同意。'),
	localize('studio.settings.approval.allDescription', '运行每条命令前，都先征求你的同意。'),
	localize('studio.settings.approval.noneDescription', '自动运行允许执行的命令，适合你信任的项目。'),
];

/** A small, user-facing settings surface backed by existing workbench services. */
export class StudioSettingsEditor extends EditorPane {
	private container: HTMLElement | undefined;
	private readonly sections = new Map<string, HTMLElement>();
	private themeButton: HTMLButtonElement | undefined;
	private modelName: HTMLElement | undefined;
	private projectName: HTMLElement | undefined;
	private approvalDescription: HTMLElement | undefined;
	private sandboxDescription: HTMLElement | undefined;
	private approvalSelect: SelectBox | undefined;
	private approvalContext: IOpenContextView | undefined;
	private approvalAnchor: DOMRect | undefined;
	private advancedButton: HTMLButtonElement | undefined;
	private advancedTools: HTMLElement | undefined;
	private savingApproval = false;
	private savingAdvanced = false;
	private dimension: dom.Dimension | undefined;
	private requestedSection: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILabelService private readonly labels: ILabelService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(STUDIO_SETTINGS_EDITOR_ID, group, telemetryService, themeService, storageService);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (['ai.modelName', 'ai.modelId', 'ai.commandApproval', 'ai.commandSandbox', STUDIO_ADVANCED_MODE_CONFIG].some(key => event.affectsConfiguration(key))) { this.update(); }
		}));
		this._register(themeService.onDidColorThemeChange(() => this.update()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.update()));
		this._register(workspace.onDidChangeWorkspaceName(() => this.update()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('div.studio-settings-editor'));
		const content = dom.append(this.container, dom.$('div.studio-settings-content'));
		const header = dom.append(content, dom.$('header.studio-settings-header'));
		dom.append(header, dom.$('h1', undefined, localize('studio.settings.heading', '按你的习惯工作')));
		dom.append(header, dom.$('p', undefined, localize('studio.settings.intro', '模型、外观和使用方式，在这里轻松调整。')));

		const appearance = this.section(content, 'appearance', Codicon.colorMode, localize('studio.settings.appearance', '外观'), localize('studio.settings.appearanceDescription', '选择舒服的阅读和工作环境。'));
		this.themeButton = this.action(appearance.actions, localize('studio.settings.toggleTheme', '切换外观'), 'aiStudio.theme.toggle');

		const models = this.section(content, 'models', Codicon.sparkle, localize('studio.settings.models', '使用的模型'), '');
		this.modelName = models.description;
		this.action(models.actions, localize('studio.settings.manageModels', '管理模型'), 'chat.modelConfiguration.open');

		const approval = this.section(content, 'approval', Codicon.shield, localize('studio.settings.approval', '执行命令前'), '');
		this.approvalDescription = approval.description;
		approval.actions.classList.add('studio-settings-approval');
		const context: IContextViewProvider = {
			showContextView: (delegate, container) => {
				this.approvalAnchor = approval.actions.getBoundingClientRect();
				this.approvalContext = this.contextViews.showContextView({ ...delegate, render: host => delegate.render(host) ?? Disposable.None }, container);
			},
			hideContextView: () => this.closeApprovalMenu(),
			layout: () => this.contextViews.layout(),
		};
		this.approvalSelect = this._register(new SelectBox(approvalLabels.map((text, index) => ({ text, description: approvalDescriptions[index] })), 0, context, defaultSelectBoxStyles, { ariaLabel: localize('studio.settings.approvalAria', '命令审批方式') }));
		this.approvalSelect.render(approval.actions);
		this._register(this.approvalSelect.onDidSelect(({ index }) => {
			if (this.savingApproval || this.configuration.inspect('ai.commandApproval').policyValue !== undefined || !approvalModes[index]) { this.update(); return; }
			this.savingApproval = true;
			void this.configuration.updateValue('ai.commandApproval', approvalModes[index], ConfigurationTarget.USER)
				.catch(error => this.notifications.error(error)).finally(() => { this.savingApproval = false; this.update(); });
		}));

		const sandbox = this.section(content, 'sandbox', Codicon.shield, localize('studio.settings.sandbox', '命令隔离'), '');
		this.sandboxDescription = sandbox.description;
		this.action(sandbox.actions, localize('studio.settings.configureSandbox', '配置隔离方式'), 'workbench.action.openSettings', 'ai.commandSandbox');

		const project = this.section(content, 'project', Codicon.folderOpened, localize('studio.settings.project', '项目文件夹'), '');
		this.projectName = project.description;
		this.action(project.actions, localize('studio.settings.chooseFolder', '选择文件夹'), 'workbench.action.files.openFolder');

		const capabilities = this.section(content, 'capabilities', Codicon.extensions, localize('studio.settings.capabilities', '技能与工具'), localize('studio.settings.capabilitiesDescription', '添加常用技能，连接你需要的工具和服务。'));
		this.action(capabilities.actions, localize('studio.settings.skills', '技能'), 'aiStudio.capabilities.open', 'skills');
		this.action(capabilities.actions, localize('studio.settings.plugins', '插件'), 'aiStudio.capabilities.open', 'plugins');
		this.action(capabilities.actions, localize('studio.settings.tools', 'MCP 连接'), 'aiStudio.capabilities.open', 'mcp');

		const network = this.section(content, 'network', Codicon.globe, localize('studio.settings.network', '网络连接'), localize('studio.settings.networkDescription', '网络请求跟随这台电脑的系统代理，无需在这里重复设置。'));
		dom.append(network.actions, dom.$('span.studio-settings-system-badge', undefined, localize('studio.settings.systemProxy', '跟随系统')));

		const advanced = this.section(content, 'advanced', Codicon.settingsGear, localize('studio.settings.advanced', '高级模式'), localize('studio.settings.advancedDescription', '显示完整设置、终端和开发工具，适合需要更多控制的用户。'));
		this.advancedButton = dom.append(advanced.actions, dom.$<HTMLButtonElement>('button.studio-settings-switch', { type: 'button', role: 'switch', 'aria-label': localize('studio.settings.advancedToggle', '高级模式'), 'aria-checked': 'false' }));
		dom.append(this.advancedButton, dom.$('span.studio-settings-switch-thumb', { 'aria-hidden': 'true' }));
		this._register(dom.addDisposableListener(this.advancedButton, 'click', () => {
			if (this.savingAdvanced || this.configuration.inspect(STUDIO_ADVANCED_MODE_CONFIG).policyValue !== undefined) { return; }
			this.savingAdvanced = true;
			this.update();
			void this.configuration.updateValue(STUDIO_ADVANCED_MODE_CONFIG, !isStudioAdvancedMode(this.configuration), ConfigurationTarget.USER)
				.catch(error => this.notifications.error(error)).finally(() => { this.savingAdvanced = false; this.update(); });
		}));
		this.advancedTools = dom.append(advanced.section, dom.$('div.studio-settings-advanced-tools'));
		const fullSettings = this.action(this.advancedTools, localize('studio.settings.fullSettings', '打开完整设置'), 'workbench.action.openSettings');
		fullSettings.classList.add('studio-settings-secondary-action');
		this._register(dom.addDisposableListener(this.container, 'scroll', () => {
			const current = approval.actions.getBoundingClientRect();
			if (this.approvalAnchor && (Math.abs(current.top - this.approvalAnchor.top) > .5 || Math.abs(current.left - this.approvalAnchor.left) > .5)) { this.closeApprovalMenu(); }
		}, true));
		this.update();
	}

	private section(parent: HTMLElement, id: string, icon: ThemeIcon, title: string, description: string): { section: HTMLElement; description: HTMLElement; actions: HTMLElement } {
		const section = dom.append(parent, dom.$('section.studio-settings-section', { 'data-section': id, tabindex: '-1', 'aria-label': title }));
		const row = dom.append(section, dom.$('div.studio-settings-row'));
		const glyph = dom.append(row, dom.$('div.studio-settings-icon', { 'aria-hidden': 'true' }));
		dom.append(glyph, renderIcon(icon));
		const copy = dom.append(row, dom.$('div.studio-settings-copy'));
		dom.append(copy, dom.$('h2', undefined, title));
		const detail = dom.append(copy, dom.$('p', undefined, description));
		const actions = dom.append(row, dom.$('div.studio-settings-actions'));
		this.sections.set(id, section);
		return { section, description: detail, actions };
	}

	private action(parent: HTMLElement, title: string, command: string, ...args: unknown[]): HTMLButtonElement {
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button.studio-settings-action', { type: 'button' }, title));
		this._register(dom.addDisposableListener(button, 'click', () => {
			if (button.getAttribute('aria-busy') === 'true') { return; }
			button.setAttribute('aria-busy', 'true');
			void this.commands.executeCommand(command, ...args).catch(error => this.notifications.error(error)).finally(() => {
				button.removeAttribute('aria-busy');
			});
		}));
		return button;
	}

	private update(): void {
		if (!this.container || this._store.isDisposed) { return; }
		if (this.themeButton) {
			const dark = isDark(this.themeService.getColorTheme().type);
			this.themeButton.textContent = dark ? localize('studio.settings.light', '切换到浅色') : localize('studio.settings.dark', '切换到深色');
		}
		if (this.modelName) {
			this.modelName.textContent = getUserAIConfiguration(this.configuration, 'ai.modelName', '') || getUserAIConfiguration(this.configuration, 'ai.modelId', '') || localize('studio.settings.noModel', '还没有配置模型，添加后即可开始任务。');
		}
		if (this.projectName) {
			const workspace = this.workspace.getWorkspace();
			this.projectName.textContent = workspace.folders.length === 1 ? this.labels.getUriLabel(workspace.folders[0].uri) : workspace.folders.length ? this.labels.getWorkspaceLabel(workspace) : localize('studio.settings.noFolder', '选择一个文件夹，让 AI 围绕你的项目工作。');
			this.projectName.title = this.projectName.textContent;
		}
		const mode = getUserAIConfiguration<string>(this.configuration, 'ai.commandApproval', 'unsafe');
		const approvalIndex = Math.max(0, approvalModes.findIndex(value => value === mode));
		// Unknown legacy values are treated conservatively by the command executor.
		const sandboxOff = getUserAIConfiguration<string>(this.configuration, 'ai.commandSandbox', 'required') === 'off';
		const effectiveIndex = !sandboxOff && approvalModes.includes(mode as typeof approvalModes[number]) ? approvalIndex : 1;
		const approvalManaged = this.configuration.inspect('ai.commandApproval').policyValue !== undefined;
		this.approvalSelect?.select(effectiveIndex);
		this.approvalSelect?.setEnabled(!approvalManaged && !sandboxOff);
		if (this.sandboxDescription) {
			this.sandboxDescription.textContent = sandboxOff
				? localize('studio.settings.sandboxDisabled', '隔离已关闭，每条命令都需要批准。')
				: localize('studio.settings.sandboxEnabled', '限制命令写入项目目录并默认阻止网络。隔离不可用时，命令不会执行。');
		}
		if (this.approvalDescription) { this.approvalDescription.textContent = approvalManaged ? localize('studio.settings.managedApproval', '{0} 此设置由管理员管理。', approvalDescriptions[effectiveIndex]) : approvalDescriptions[effectiveIndex]; }
		const advanced = isStudioAdvancedMode(this.configuration);
		if (this.advancedButton) {
			this.advancedButton.setAttribute('aria-checked', String(advanced));
			this.advancedButton.setAttribute('aria-busy', String(this.savingAdvanced));
			this.advancedButton.disabled = this.configuration.inspect(STUDIO_ADVANCED_MODE_CONFIG).policyValue !== undefined;
		}
		if (this.advancedTools) { this.advancedTools.hidden = !advanced; }
	}

	private revealSection(): void {
		const key = this.requestedSection === 'safety' ? 'approval' : this.requestedSection;
		const section = key ? this.sections.get(key) : undefined;
		if (section) { section.scrollIntoView({ block: 'center' }); section.focus({ preventScroll: true }); }
		else { this.container?.scrollTo({ top: 0 }); }
	}

	private closeApprovalMenu(): void {
		const menu = this.approvalContext;
		this.approvalContext = undefined;
		this.approvalAnchor = undefined;
		menu?.close();
	}

	override async setInput(input: StudioSettingsEditorInput, options: IStudioSettingsOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.requestedSection = options?.section;
		this.update();
		this.revealSection();
	}
	override setOptions(options: IStudioSettingsOptions | undefined): void {
		super.setOptions(options);
		this.requestedSection = options?.section;
		this.revealSection();
	}
	override layout(dimension: dom.Dimension): void {
		if (this.dimension?.width !== dimension.width || this.dimension?.height !== dimension.height) { this.closeApprovalMenu(); }
		this.dimension = dimension;
		if (this.container) { dom.size(this.container, dimension.width, dimension.height); }
	}
	override focus(): void {
		super.focus();
		if (this.requestedSection) { this.revealSection(); } else { this.themeButton?.focus(); }
	}
	protected override setEditorVisible(visible: boolean): void {
		if (!visible) { this.closeApprovalMenu(); }
		super.setEditorVisible(visible);
		if (visible) { this.update(); }
	}
	override clearInput(): void { this.closeApprovalMenu(); super.clearInput(); }
	override dispose(): void { this.closeApprovalMenu(); super.dispose(); }
}
