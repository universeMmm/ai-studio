/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Active model and session status.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import { IAIModelService } from '../../../../platform/ai/browser/aiModelService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';

class AIStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiStatusBar';
	constructor(
		@IStatusbarService statusbar: IStatusbarService,
		@IAIModelService models: IAIModelService,
		@IAIAgentService agent: IAIAgentService,
		@IConfigurationService config: IConfigurationService,
		@IChatWidgetService chats: IChatWidgetService,
	) {
		super();
		const content = () => {
			const states = {
				idle: ['sparkle', '就绪'], running: ['sync~spin', '执行中'], waiting_for_approval: ['bell', '等待确认'],
				stopped: ['circle-outline', '已结束'], error: ['error', '运行失败'],
			} as const;
			const status = chats.lastFocusedWidget?.viewModel?.sessionResource.toString() === agent.sessionId ? agent.status : 'idle';
			const [icon, state] = states[status];
			const model = models.currentModelId ? models.currentModelName : undefined;
			if (!model && status === 'idle') {
				return { name: '智能体状态', text: '$(gear) 配置模型', ariaLabel: '尚未配置模型，打开模型设置', tooltip: '配置模型服务', command: 'chat.modelConfiguration.open' };
			}
			const label = model ? `${model} · ${state}` : state;
			return {
				name: '智能体状态', text: `$(${icon}) ${status === 'idle' && model ? model : state}`, ariaLabel: label,
				tooltip: `${label}\n打开任务执行记录`, command: { id: 'aiStudio.openInspector', title: '执行记录', arguments: ['activity'] },
			};
		};
		const entry = this._register(statusbar.addEntry(content(), 'ai.statusBar', StatusbarAlignment.RIGHT, 100));
		this._register(agent.onDidChangeStatus(() => entry.update(content())));
		this._register(chats.onDidChangeFocusedSession(() => entry.update(content())));
		this._register(config.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ai')) { entry.update(content()); } }));
	}
}
registerWorkbenchContribution2(AIStatusBarContribution.ID, AIStatusBarContribution, WorkbenchPhase.AfterRestored);
