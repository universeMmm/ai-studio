import { renderIcon } from './icons.js';

export interface ActionBarCallbacks {
  onApplyAll: () => void;
  onRejectAll: () => void;
}

export function renderActionBar(callbacks: ActionBarCallbacks, count: number): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'ai-action-bar';

  const applyBtn = document.createElement('button');
  applyBtn.className = 'ai-action-bar__primary';
  applyBtn.appendChild(renderIcon('apply'));
  const applyText = document.createElement('span');
  applyText.textContent = `Apply All (${count})`;
  applyBtn.appendChild(applyText);
  applyBtn.addEventListener('click', callbacks.onApplyAll);
  bar.appendChild(applyBtn);

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'ai-action-bar__secondary';
  rejectBtn.appendChild(renderIcon('reject'));
  const rejectText = document.createElement('span');
  rejectText.textContent = 'Reject All';
  rejectBtn.appendChild(rejectText);
  rejectBtn.addEventListener('click', callbacks.onRejectAll);
  bar.appendChild(rejectBtn);

  const hint = document.createElement('span');
  hint.className = 'ai-action-bar__hint';
  hint.appendChild(renderIcon('commandKey'));
  hint.appendChild(document.createTextNode(' Enter'));
  bar.appendChild(hint);

  return bar;
}
