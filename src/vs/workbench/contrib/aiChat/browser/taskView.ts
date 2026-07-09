/*---------------------------------------------------------------------------------------------
 *  AI Studio — Task View
 *  Renders the current task list (from TaskManager) as a live progress panel.
 *  Listens to IAIAgentService.onDidChangeTasks and re-renders on every change.
 *  Replaces planView.ts.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import { renderTasks, renderTaskSummary } from './taskStepRenderer.js';

export class TaskView extends Disposable {
	private _container: HTMLElement | null = null;

	constructor(
		@IAIAgentService private readonly agentService: IAIAgentService
	) {
		super();
		this._register(this.agentService.onDidChangeTasks(() => this._render()));
	}

	attach(container: HTMLElement): void {
		this._container = container;
		this._render();
	}

	private _render(): void {
		if (!this._container) return;
		this._container.innerHTML = '';

		const tasks = this.agentService.tasks;
		if (!tasks || !tasks.length) {
			this._container.style.display = 'none';
			return;
		}

		this._container.style.display = 'block';
		const wrapper = document.createElement('div');
		wrapper.style.cssText = 'padding:8px 12px;margin:0 0 8px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-editor-background);';

		const header = document.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:600;';
		header.textContent = renderTaskSummary(tasks);
		wrapper.appendChild(header);
		wrapper.appendChild(renderTasks(tasks));
		this._container.appendChild(wrapper);
	}
}
