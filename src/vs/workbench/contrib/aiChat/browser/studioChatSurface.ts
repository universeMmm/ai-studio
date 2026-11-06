/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Desktop conversation workspace
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ChatWidget } from '../../chat/browser/widget/chatWidget.js';
import './media/studioWorkspace.css';

const $ = dom.$;

export class StudioChatSurface extends Disposable {
	readonly thread: HTMLElement;
	private readonly header: HTMLElement;
	private readonly welcome = $('.studio-welcome');
	private readonly prompts = $('.studio-starters');
	private readonly folderLabel: HTMLElement;

	constructor(
		private readonly parent: HTMLElement,
		private readonly widget: ChatWidget,
		@IConfigurationService configuration: IConfigurationService,
		@IPreferencesService preferences: IPreferencesService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILabelService private readonly labels: ILabelService
	) {
		super();
		parent.classList.add('studio-chat-editor');
		this.header = dom.append(parent, $('header.studio-thread-header'));
		const folder = dom.append(this.header, $('.studio-thread-folder'));
		dom.append(folder, renderIcon(Codicon.folderOpened));
		this.folderLabel = dom.append(folder, $('span'));
		this.updateWorkspace();
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.updateWorkspace()));
		this._register(workspace.onDidChangeWorkspaceName(() => this.updateWorkspace()));

		const approval = dom.append(this.header, $('button.studio-header-button', { type: 'button' }));
		dom.append(approval, renderIcon(Codicon.shield));
		const policy = dom.append(approval, $('span'));
		const updatePolicy = () => {
			const mode = configuration.getValue<string>('ai.commandApproval');
			policy.textContent = mode === 'all' ? localize('studio.approveAll', "逐条审批命令")
				: mode === 'none' ? localize('studio.approvalOff', "自动执行命令") : localize('studio.approveUnsafe', "按需审批命令");
		};
		updatePolicy();
		this._register(configuration.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ai.commandApproval')) { updatePolicy(); } }));
		this._register(dom.addDisposableListener(approval, 'click', () => preferences.openUserSettings({ query: '@id:ai.commandApproval' })));
		this.thread = dom.append(parent, $('.studio-thread'));
		widget.render(this.thread);
		widget.domNode.prepend(this.welcome);
		widget.domNode.appendChild(this.prompts);

		dom.append(this.welcome, $('.studio-agent-mark', { 'aria-hidden': 'true' }));
		dom.append(this.welcome, $('h1', undefined, localize('studio.welcome', "今天想一起做什么？")));
		this.addStarter(Codicon.symbolNamespace, localize('studio.explore', "了解项目结构"), localize('studio.explorePrompt', "请从主要入口开始梳理这个项目，解释核心模块之间如何协作。"));
		this.addStarter(Codicon.gitPullRequest, localize('studio.reviewWork', "检查当前改动"), localize('studio.reviewPrompt', "请审查工作区中的改动，重点检查正确性、回归风险和缺少的测试。"));
		this.addStarter(Codicon.beaker, localize('studio.test', "查找相关测试"), localize('studio.testPrompt', "请找出这个项目的测试入口，说明当前任务应该运行哪些检查。"));
		this.updateEmptyState();
		this._register(widget.onDidChangeEmptyState(() => this.updateEmptyState()));
	}

	private updateWorkspace(): void {
		const workspace = this.workspace.getWorkspace();
		const label = workspace.folders.length ? this.labels.getWorkspaceLabel(workspace) : localize('studio.noFolder', "未打开文件夹");
		this.folderLabel.textContent = label;
		this.folderLabel.title = label;
	}

	private updateEmptyState(): void {
		const empty = this.widget.isEmpty() && !this.widget.isLockedToCodingAgent;
		this.parent.classList.toggle('studio-new-session', empty);
		this.welcome.hidden = !empty;
		this.prompts.hidden = !empty;
	}

	private addStarter(icon: ThemeIcon, title: string, prompt: string): void {
		const button = dom.append(this.prompts, $('button.studio-starter', { type: 'button', title: prompt }));
		dom.append(button, renderIcon(icon), $('span', undefined, title), renderIcon(Codicon.arrowRight));
		this._register(dom.addDisposableListener(button, 'click', () => {
			this.widget.setInput(prompt);
			this.widget.focusInput();
		}));
	}

	layout(height: number, width: number): void {
		const threadHeight = Math.max(0, height - this.header.offsetHeight);
		this.thread.style.height = threadHeight + 'px';
		this.widget.layout(threadHeight, this.thread.clientWidth || width);
	}
}
