/*---------------------------------------------------------------------------------------------
 *  AI Studio — Diff Decorator
 *  Shows green line decorations in the editor for applied AI edits.
 *  After the edit is applied, only the modified range exists in the file,
 *  so we decorate the new content at its actual position.
 *--------------------------------------------------------------------------------------------*/

import './diffDecorator.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IDiffStore } from './diffStore.js';
import type { DiffHunk } from '../common/diffTypes.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { IModelDeltaDecoration, ITextModel } from '../../../../editor/common/model.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';

export class DiffDecorator extends Disposable {
	private static readonly ADDED_CLASS = 'ai-diff-block-added';
	private static readonly MAX_DECORATIONS = 100;

	private readonly _decIds = new Map<string, string[]>();

	constructor(
		@IDiffStore private readonly diffStore: IDiffStore,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._register(this.diffStore.onDidChange(() => this._refresh()));
		// Also refresh whenever editors change (tab switches, file opens)
		this._register(this.editorService.onDidActiveEditorChange(() => this._refresh()));
		this._register(this.editorService.onDidVisibleEditorsChange(() => this._refresh()));
		// Initial refresh
		this._refresh();
	}

	private _refresh(): void {
		const applied = this.diffStore.getAllAppliedHunks();
		if (!applied.length) return;

		const byFile = new Map<string, DiffHunk[]>();
		for (const h of applied) {
			const arr = byFile.get(h.filePath) || [];
			arr.push(h);
			byFile.set(h.filePath, arr);
		}

		for (const [fp, hunks] of byFile) {
			const model = this._findModel(URI.file(fp));
			if (model) {
				this._updateModel(model, hunks);
			}
		}
	}

	private _updateModel(model: ITextModel, hunks: DiffHunk[]): void {
		const decs: IModelDeltaDecoration[] = [];
		let count = 0;
		for (const h of hunks) {
			if (count++ >= DiffDecorator.MAX_DECORATIONS) break;
			// After edit, only modified range exists in the file.
			// Decorate the new content at its actual position.
			if (h.modifiedText && h.modifiedEndLine > 0) {
				decs.push({
					range: new Range(h.modifiedStartLine, 1, h.modifiedEndLine, 1),
					options: {
						description: 'AI Studio diff',
						isWholeLine: true,
						className: DiffDecorator.ADDED_CLASS,
						glyphMarginClassName: 'ai-diff-glyph-added',
					},
				});
			}
		}
		const uriStr = model.uri.toString();
		const oldIds = this._decIds.get(uriStr) || [];
		this._decIds.set(uriStr, model.deltaDecorations(oldIds, decs));
	}

	private _findModel(uri: URI): ITextModel | null {
		// Check all visible editors
		for (const ed of this.editorService.visibleTextEditorControls) {
			const m = (ed as any).getModel?.() as ITextModel | null;
			if (m?.uri?.toString() === uri.toString()) return m;
		}
		return null;
	}
}
