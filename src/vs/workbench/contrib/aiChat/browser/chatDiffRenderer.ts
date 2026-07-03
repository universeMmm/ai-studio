/*---------------------------------------------------------------------------------------------
 *  AI Studio — Chat Diff Renderer (WCAG 2.1 AA)
 *  Renders diff hunks as accessible, keyboard-navigable HTML cards.
 *--------------------------------------------------------------------------------------------*/

import type { DiffGroup, DiffHunk } from '../../aiDiffApply/common/diffTypes.js';
import { IDiffStore } from '../../aiDiffApply/browser/diffStore.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';

export function renderDiffGroup(group: DiffGroup, diffStore: IDiffStore, editorService: IEditorService): HTMLElement[] {
	const byFile = new Map<string, DiffHunk[]>();
	for (const h of group.hunks) { const arr = byFile.get(h.filePath) || []; arr.push(h); byFile.set(h.filePath, arr); }
	return [...byFile.entries()].map(([fp, hunks]) => _createCard(fp, hunks, group.id, diffStore, editorService));
}

function _createCard(filePath: string, hunks: DiffHunk[], groupId: string, diffStore: IDiffStore, editorService: IEditorService): HTMLElement {
	const card = document.createElement('div');
	card.setAttribute('role', 'region');
	card.setAttribute('aria-label', 'Diff for ' + filePath);
	Object.assign(card.style, { marginBottom: '12px', border: '1px solid var(--vscode-panel-border)', borderRadius: '4px', overflow: 'hidden' });

	const header = document.createElement('div');
	header.setAttribute('role', 'button');
	header.setAttribute('tabindex', '0');
	header.setAttribute('aria-label', 'Open file: ' + filePath);
	Object.assign(header.style, { padding: '6px 12px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: 'var(--vscode-textBlockQuote-background)' });
	header.textContent = '\u{1F4C4} ' + filePath;

	const openFile = () => {
		const h = hunks[0];
		editorService.openEditor({ resource: URI.file(filePath), options: { selection: h ? { startLineNumber: h.modifiedStartLine, startColumn: 1, endLineNumber: h.modifiedStartLine, endColumn: 1 } : undefined } });
	};
	header.addEventListener('click', openFile);
	header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(); } });
	card.appendChild(header);

	const body = document.createElement('div');
	body.setAttribute('role', 'list');
	body.setAttribute('aria-label', 'Changes in ' + filePath);
	Object.assign(body.style, { padding: '8px 0', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', lineHeight: '1.6' });

	for (let idx = 0; idx < hunks.length; idx++) {
		const h = hunks[idx];
		const hunkContainer = document.createElement('div');
		hunkContainer.setAttribute('role', 'listitem');
		hunkContainer.setAttribute('aria-label', 'Change ' + (idx + 1) + ' of ' + hunks.length);
		if (h.originalText) {
			const el = document.createElement('div');
			el.setAttribute('role', 'note');
			el.setAttribute('aria-label', 'Removed lines');
			el.style.cssText = 'background:rgba(255,100,100,0.15);border-left:3px solid rgba(255,100,100,0.4);padding:2px 8px;white-space:pre';
			el.textContent = h.originalText.split('\n').map(l => '- ' + l).join('\n');
			hunkContainer.appendChild(el);
		}
		if (h.modifiedText) {
			const el = document.createElement('div');
			el.setAttribute('role', 'note');
			el.setAttribute('aria-label', 'Added lines');
			el.style.cssText = 'background:rgba(100,200,100,0.15);border-left:3px solid rgba(100,200,100,0.4);padding:2px 8px;white-space:pre';
			el.textContent = h.modifiedText.split('\n').map(l => '+ ' + l).join('\n');
			hunkContainer.appendChild(el);
		}
		body.appendChild(hunkContainer);
	}
	card.appendChild(body);

	const hasApplied = hunks.some(h => h.status === 'applied');
	if (hasApplied) {
		const btn = document.createElement('button');
		btn.textContent = 'Reject All';
		btn.setAttribute('aria-label', 'Reject all changes in ' + filePath);
		btn.setAttribute('tabindex', '0');
		Object.assign(btn.style, { margin: '8px 12px', padding: '4px 12px', cursor: 'pointer' });
		btn.addEventListener('click', () => diffStore.rejectAll(groupId));
		btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); diffStore.rejectAll(groupId); } });
		card.appendChild(btn);
	}
	return card;
}
