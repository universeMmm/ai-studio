import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import { AIIcon, renderIcon } from './icons.js';

const STEP_STYLES: Record<string, { icon: AIIcon; color: string }> = {
  thought: { icon: 'timelineThought', color: 'var(--vscode-textLink-foreground)' },
  tool_use: { icon: 'timelineToolUse', color: 'var(--vscode-testing-iconPassed)' },
  tool_result: { icon: 'timelineToolResult', color: 'var(--vscode-descriptionForeground)' },
  error: { icon: 'timelineError', color: 'var(--vscode-errorForeground)' },
  plan: { icon: 'timelinePlan', color: 'var(--vscode-charts-purple)' },
};

export class TimelineView extends Disposable {
  private _container: HTMLElement | null = null;

  constructor(
    @IAIAgentService private readonly agentService: IAIAgentService
  ) {
    super();
    this._register(this.agentService.onDidAddStep(() => this._render()));
  }

  attach(container: HTMLElement): void {
    this._container = container;
    this._render();
  }

  private _render(): void {
    if (!this._container) return;
    this._container.innerHTML = '';

    const steps = this.agentService.steps;
    if (!steps.length) {
      this._container.style.display = 'none';
      return;
    }

    this._container.style.display = 'block';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:6px 12px;margin:4px 0;border-left:2px solid var(--vscode-widget-border);';

    for (const step of steps) {
      const style = STEP_STYLES[step.type] || { icon: 'planPending' as AIIcon, color: 'var(--vscode-foreground)' };
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;padding:2px 0;font-size:11px;';

      const icon = renderIcon(style.icon);
      icon.style.cssText += 'flex-shrink:0;margin-top:2px;color:' + style.color + ';';
      row.appendChild(icon);

      const body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0;';

      const num = document.createElement('span');
      num.style.cssText = 'font-weight:500;color:' + style.color + ';';
      num.textContent = '#' + step.stepNumber;
      body.appendChild(num);

      const time = document.createElement('span');
      time.style.cssText = 'color:var(--vscode-descriptionForeground);margin-left:4px;';
      time.textContent = new Date(step.timestamp).toLocaleTimeString();
      body.appendChild(time);

      const content = document.createElement('span');
      content.style.cssText = 'color:var(--vscode-foreground);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      content.textContent = step.content.substring(0, 120);
      body.appendChild(content);

      row.appendChild(body);
      wrapper.appendChild(row);
    }

    this._container.appendChild(wrapper);
  }
}
