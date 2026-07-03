/*---------------------------------------------------------------------------------------------
 *  AI Studio — Status Bar Contribution
 *  Shows AI model name and agent status/errors with ARIA labels.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAIModelService } from '../../../../platform/ai/browser/aiModelService.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';

class AIStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiStatusBar';

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._registerStatusBar();
	}

	private _registerStatusBar(): void {
		const modelService = this.instantiationService.invokeFunction(a => a.get(IAIModelService));
		const agentService = this.instantiationService.invokeFunction(a => a.get(IAIAgentService));

		const entry = this.statusbarService.addEntry(
			{
				name: 'AI Model',
				text: `$(hubot) ${modelService.currentModelName}`,
				tooltip: 'AI Studio — Current Model',
				ariaLabel: 'AI Studio Current Model: ' + modelService.currentModelName,
				command: 'ai.chat.open',
			},
			'ai.statusBar',
			StatusbarAlignment.RIGHT,
			100,
		);

		this._register(agentService.onDidChangeStatus(status => {
			if (status === 'error') {
				const errorStep = [...agentService.steps].reverse().find(s => s.type === 'error');
				entry.update({
					name: 'AI Error',
					text: `$(error) AI Error`,
					tooltip: errorStep?.content || 'AI Agent encountered an error',
					ariaLabel: 'AI Error: ' + (errorStep?.content || 'Unknown error'),
					command: 'ai.chat.open',
				});
			} else if (status === 'running') {
				entry.update({
					name: 'AI Working',
					text: `$(sync~spin) AI Working...`,
					tooltip: 'AI Agent is working',
					ariaLabel: 'AI Agent is currently working',
					command: 'ai.chat.open',
				});
			} else {
				entry.update({
					name: 'AI Model',
					text: `$(hubot) ${modelService.currentModelName}`,
					tooltip: 'AI Studio — Ready',
					ariaLabel: 'AI Studio Model: ' + modelService.currentModelName,
					command: 'ai.chat.open',
				});
			}
		}));
	}
}

registerWorkbenchContribution2(AIStatusBarContribution.ID, AIStatusBarContribution, WorkbenchPhase.AfterRestored);
