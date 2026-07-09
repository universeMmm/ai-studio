/*---------------------------------------------------------------------------------------------
 *  AI Studio — Task Step Renderer
 *  Renders Task objects (from TaskManager) as DOM elements with status icons,
 *  dependency info, and owner display. Replaces planStepRenderer.ts.
 *--------------------------------------------------------------------------------------------*/

import type { Task } from '../../../../platform/ai/common/aiTypes.js';
import { renderIcon } from './icons.js';

export function renderTasks(tasks: readonly Task[]): HTMLElement {
	const container = document.createElement('div');
	container.className = 'ai-task-steps';
	container.setAttribute('role', 'list');

	if (!tasks.length) {
		const empty = document.createElement('div');
		empty.textContent = 'No tasks yet.';
		empty.style.cssText = 'color:var(--vscode-descriptionForeground);font-style:italic;padding:4px 0;';
		container.appendChild(empty);
		return container;
	}

	for (const task of tasks) {
		const el = document.createElement('div');
		el.className = 'ai-task-step';
		el.setAttribute('role', 'listitem');

		switch (task.status) {
			case 'completed':
				el.classList.add('ai-task-step--completed');
				el.appendChild(renderIcon('planCompleted'));
				break;
			case 'in_progress':
				el.classList.add('ai-task-step--in-progress');
				el.appendChild(renderIcon('planInProgress'));
				break;
			case 'deleted':
				el.classList.add('ai-task-step--deleted');
				el.appendChild(renderIcon('planFailed'));
				break;
			default:
				el.classList.add('ai-task-step--pending');
				el.appendChild(renderIcon('planPending'));
				break;
		}

		const text = document.createElement('span');
		let label = task.subject;
		if (task.owner) {
			label += ' (' + task.owner + ')';
		}
		if (task.blockedBy && task.blockedBy.length > 0) {
			label += ' [blocks: ' + task.blockedBy.join(', ') + ']';
		}
		text.textContent = label;
		el.appendChild(text);
		container.appendChild(el);
	}
	return container;
}

export function renderTaskSummary(tasks: readonly Task[]): string {
	const total = tasks.filter(t => t.status !== 'deleted').length;
	const completed = tasks.filter(t => t.status === 'completed').length;
	const inProgress = tasks.filter(t => t.status === 'in_progress').length;
	let summary = 'Tasks (' + completed + '/' + total + ' done';
	if (inProgress > 0) {
		summary += ', ' + inProgress + ' in progress';
	}
	summary += ')';
	return summary;
}
