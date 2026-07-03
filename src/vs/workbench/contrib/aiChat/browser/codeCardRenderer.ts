import type { DiffGroup, DiffHunk } from '../../aiDiffApply/common/diffTypes.js';
import { IDiffStore } from '../../aiDiffApply/browser/diffStore.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { renderIcon } from './icons.js';

export function renderCodeCard(
  group: DiffGroup,
  diffStore: IDiffStore,
  editorService: IEditorService
): HTMLElement {
  const byFile = new Map<string, DiffHunk[]>();
  for (const h of group.hunks) {
    const arr = byFile.get(h.filePath) || [];
    arr.push(h);
    byFile.set(h.filePath, arr);
  }

  const container = document.createElement('div');
  for (const [fp, hunks] of byFile) {
    container.appendChild(_buildCard(fp, hunks, group.id, diffStore, editorService));
  }
  return container;
}

function _buildCard(
  filePath: string,
  hunks: DiffHunk[],
  groupId: string,
  diffStore: IDiffStore,
  editorService: IEditorService
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ai-code-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Diff for ' + filePath);

  const fileName = filePath.replace(/^.*[\\/]/, '');
  const totalAdd = hunks.reduce((s, h) => s + (h.modifiedText ? h.modifiedText.split('\n').length : 0), 0);
  const totalDel = hunks.reduce((s, h) => s + (h.originalText ? h.originalText.split('\n').length : 0), 0);
  const isNew = totalDel === 0;

  // Header
  const header = document.createElement('div');
  header.className = 'ai-code-card__header';
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'false');

  const chevron = renderIcon('chevronRight', 'ai-code-card__chevron');
  header.appendChild(chevron);
  header.appendChild(renderIcon('file'));

  const fname = document.createElement('span');
  fname.className = 'ai-code-card__filename';
  fname.textContent = fileName;
  header.appendChild(fname);

  const badge = document.createElement('span');
  badge.className = 'ai-code-card__badge';
  if (isNew) {
    badge.classList.add('ai-code-card__badge--new');
    badge.textContent = '+' + totalAdd + ' new';
  } else {
    badge.classList.add('ai-code-card__badge--modified');
    badge.textContent = '+' + totalAdd + ' −' + totalDel;
  }
  header.appendChild(badge);

  const time = document.createElement('span');
  time.className = 'ai-code-card__time';
  time.textContent = new Date().toLocaleTimeString();
  header.appendChild(time);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'ai-code-card__action ai-code-card__action--apply';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.add('ai-code-card--applied');
    badge.classList.remove('ai-code-card__badge--modified', 'ai-code-card__badge--new');
    badge.classList.add('ai-code-card__badge--applied');
    badge.textContent = '✓ Applied';
    applyBtn.disabled = true;
  });
  header.appendChild(applyBtn);

  // Diff body (hidden by default)
  const diffBody = document.createElement('div');
  diffBody.className = 'ai-code-card__diff';
  diffBody.style.display = 'none';
  diffBody.setAttribute('role', 'list');
  diffBody.setAttribute('aria-label', 'Changes in ' + fileName);

  for (const h of hunks) {
    if (h.originalText) {
      const el = document.createElement('div');
      el.className = 'ai-code-card__diff-remove';
      el.setAttribute('role', 'listitem');
      el.textContent = h.originalText.split('\n').map(l => '- ' + l).join('\n');
      diffBody.appendChild(el);
    }
    if (h.modifiedText) {
      const el = document.createElement('div');
      el.className = 'ai-code-card__diff-add';
      el.setAttribute('role', 'listitem');
      el.textContent = h.modifiedText.split('\n').map(l => '+ ' + l).join('\n');
      diffBody.appendChild(el);
    }
  }

  // Diff actions
  const diffActions = document.createElement('div');
  diffActions.className = 'ai-code-card__diff-actions';

  const diffApply = document.createElement('button');
  diffApply.className = 'ai-code-card__action ai-code-card__action--apply';
  diffApply.textContent = 'Apply';
  diffApply.addEventListener('click', () => {
    card.classList.add('ai-code-card--applied');
    applyBtn.disabled = true;
    diffApply.disabled = true;
  });
  diffActions.appendChild(diffApply);

  const diffReject = document.createElement('button');
  diffReject.className = 'ai-code-card__action ai-code-card__action--reject';
  diffReject.textContent = 'Reject';
  diffReject.addEventListener('click', () => {
    card.classList.add('ai-code-card--rejected');
    setTimeout(() => card.remove(), 2000);
    diffStore.rejectAll(groupId);
  });
  diffActions.appendChild(diffReject);

  const openBtn = document.createElement('button');
  openBtn.className = 'ai-code-card__action--open-editor';
  openBtn.textContent = 'Open in Editor ↗';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const h = hunks[0];
    editorService.openEditor({
      resource: URI.file(filePath),
      options: { selection: h ? { startLineNumber: h.modifiedStartLine, startColumn: 1, endLineNumber: h.modifiedStartLine, endColumn: 1 } : undefined }
    });
  });
  diffActions.appendChild(openBtn);

  diffBody.appendChild(diffActions);
  card.appendChild(diffBody);

  // Toggle expand/collapse
  const toggle = () => {
    const isOpen = diffBody.style.display !== 'none';
    diffBody.style.display = isOpen ? 'none' : 'block';
    chevron.classList.toggle('ai-code-card__chevron--expanded', !isOpen);
    header.setAttribute('aria-expanded', String(!isOpen));
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  return card;
}
