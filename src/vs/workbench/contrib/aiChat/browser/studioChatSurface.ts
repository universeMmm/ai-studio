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
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getUserAIConfiguration } from '../../../../platform/ai/common/aiSecurityConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ChatWidget } from '../../chat/browser/widget/chatWidget.js';
import './media/studioWorkspace.css';

const $ = dom.$;

export class StudioChatSurface extends Disposable {
	readonly thread: HTMLElement;
	private readonly header: HTMLElement;
	private readonly welcome = $('section.studio-welcome');
	private readonly folderLabel: HTMLElement;

	constructor(
		private readonly parent: HTMLElement,
		private readonly widget: ChatWidget,
		@IConfigurationService configuration: IConfigurationService,
		@ICommandService commands: ICommandService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILabelService private readonly labels: ILabelService
	) {
		super();
		parent.classList.add('studio-chat-editor');
		this.header = dom.append(parent, $('header.studio-thread-header'));
		const folder = dom.append(this.header, $('.studio-thread-folder'));
		dom.append(folder, renderIcon(Codicon.folderOpened));
		this.folderLabel = dom.append(folder, $('span.studio-thread-project'));
		this.updateWorkspace();
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.updateWorkspace()));
		this._register(workspace.onDidChangeWorkspaceName(() => this.updateWorkspace()));

		const approval = $('button.studio-composer-approval', { type: 'button' });
		dom.append(approval, renderIcon(Codicon.shield));
		const policy = dom.append(approval, $('span'));
		const updatePolicy = () => {
			const mode = getUserAIConfiguration<string>(configuration, 'ai.commandApproval', 'unsafe');
			policy.textContent = mode === 'all' ? localize('studio.approveAll', "逐条审批")
				: mode === 'none' ? localize('studio.approvalOff', "自动执行") : localize('studio.approveUnsafe', "按需审批");
			approval.title = localize('studio.approvalSettings', "{0} · 更改审批设置", policy.textContent);
			approval.setAttribute('aria-label', approval.title);
		};
		updatePolicy();
		this._register(configuration.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ai.commandApproval')) { updatePolicy(); } }));
		this._register(dom.addDisposableListener(approval, 'click', event => {
			event.stopPropagation();
			void commands.executeCommand('aiStudio.settings.open', 'approval').catch(onUnexpectedError);
		}));
		// The attachment action owns the surrounding native action item. Keep its
		// keyboard and mouse handlers from also opening attachments for this button.
		for (const event of ['mousedown', 'keydown', 'keyup']) {
			this._register(dom.addDisposableListener(approval, event, e => e.stopPropagation()));
		}
		this.thread = dom.append(parent, $('.studio-thread'));
		widget.render(this.thread);
		widget.domNode.prepend(this.welcome);
		widget.inputEditor.updateOptions({ fontSize: 14, lineHeight: 22, padding: { top: 16, bottom: 18 } });
		// Use the existing action bar item so native toolbar width measurements
		// include approval alongside the attachment button. Menus can recreate it.
		// eslint-disable-next-line no-restricted-syntax
		const toolbars = widget.domNode.querySelector<HTMLElement>('.chat-input-toolbars');
		if (toolbars) {
			const placeApproval = () => {
				// eslint-disable-next-line no-restricted-syntax
				const attachment = toolbars.querySelector<HTMLElement>('.chat-input-toolbar .action-item:has(.codicon-add)');
				// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
				const addButton = attachment?.querySelector<HTMLElement>('.action-label.codicon-add');
				if (addButton) {
					addButton.setAttribute('aria-label', localize('studio.addMenu', "添加附件、技能和插件"));
					addButton.setAttribute('aria-haspopup', 'menu');
				}
				const target = attachment ?? toolbars;
				if (approval.parentElement === target) { return; }
				attachment?.classList.add('studio-composer-leading');
				target.appendChild(approval);
				if (this.thread.clientWidth) { widget.input.layout(this.thread.clientWidth); }
			};
			placeApproval();
			const observer = new (dom.getWindow(toolbars).MutationObserver)(placeApproval);
			observer.observe(toolbars, { childList: true, subtree: true });
			this._register(toDisposable(() => { observer.disconnect(); approval.remove(); }));
		}

		dom.append(this.welcome, $('h1', undefined, localize('studio.welcome', "从一个任务开始")));
		this.updateEmptyState();
		this._register(widget.onDidChangeEmptyState(() => this.updateEmptyState()));
	}

	private updateWorkspace(): void {
		const workspace = this.workspace.getWorkspace();
		const label = workspace.folders.length ? this.labels.getWorkspaceLabel(workspace) : localize('studio.noFolder', "未打开文件夹");
		this.folderLabel.textContent = label;
		this.folderLabel.title = label;
		this.parent.setAttribute('aria-label', localize('studio.conversationWorkspace', "会话 · {0}", label));
	}

	private updateEmptyState(): void {
		const empty = this.widget.isEmpty() && !this.widget.isLockedToCodingAgent;
		this.parent.classList.toggle('studio-new-session', empty);
		this.welcome.hidden = !empty;
	}

	layout(height: number, width: number): void {
		const threadHeight = Math.max(0, height - this.header.offsetHeight);
		this.thread.style.height = threadHeight + 'px';
		this.widget.layout(threadHeight, this.thread.clientWidth || width);
	}
}
