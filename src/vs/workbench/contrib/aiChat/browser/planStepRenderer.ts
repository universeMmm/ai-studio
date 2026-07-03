import type { AgentPlan } from '../../../../platform/ai/common/aiTypes.js';
import { renderIcon } from './icons.js';

export function renderPlanSteps(plan: AgentPlan): HTMLElement {
  const container = document.createElement('div');
  container.className = 'ai-plan-steps';
  container.setAttribute('role', 'list');

  for (const step of plan.steps) {
    const el = document.createElement('div');
    el.className = 'ai-plan-step';
    el.setAttribute('role', 'listitem');

    switch (step.status) {
      case 'completed':
        el.classList.add('ai-plan-step--completed');
        el.appendChild(renderIcon('planCompleted'));
        break;
      case 'in_progress':
        el.classList.add('ai-plan-step--in-progress');
        el.appendChild(renderIcon('planInProgress'));
        break;
      case 'failed':
        el.classList.add('ai-plan-step--failed');
        el.appendChild(renderIcon('planFailed'));
        break;
      default:
        el.classList.add('ai-plan-step--pending');
        el.appendChild(renderIcon('planPending'));
        break;
    }

    const text = document.createElement('span');
    text.textContent = step.title;
    el.appendChild(text);
    container.appendChild(el);
  }
  return container;
}

export function renderPlanSummary(plan: AgentPlan): string {
  const completed = plan.steps.filter(s => s.status === 'completed').length;
  return `Execution Plan (${completed}/${plan.steps.length})`;
}
