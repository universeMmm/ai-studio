import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import { renderPlanSteps, renderPlanSummary } from './planStepRenderer.js';

export class PlanView extends Disposable {
  private _container: HTMLElement | null = null;

  constructor(
    @IAIAgentService private readonly agentService: IAIAgentService
  ) {
    super();
    this._register(this.agentService.onDidChangePlan(() => this._render()));
  }

  attach(container: HTMLElement): void {
    this._container = container;
    this._render();
  }

  private _render(): void {
    if (!this._container) return;
    this._container.innerHTML = '';

    const plan = this.agentService.plan;
    if (!plan || !plan.steps.length) {
      this._container.style.display = 'none';
      return;
    }

    this._container.style.display = 'block';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:8px 12px;margin:0 0 8px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-editor-background);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:600;';
    header.textContent = renderPlanSummary(plan);
    wrapper.appendChild(header);
    wrapper.appendChild(renderPlanSteps(plan));
    this._container.appendChild(wrapper);
  }
}
