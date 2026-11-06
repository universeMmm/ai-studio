/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { IModelService } from '../../../../editor/common/services/model.js';
import { Range } from '../../../../editor/common/core/range.js';

export class DiffDecorator extends Disposable {
	private static readonly ADDED_CLASS = 'ai-diff-block-added';
	private static readonly MAX_DECORATIONS = 100;

	private readonly _decIds = new Map<ITextModel, string[]>();

	constructor(
		@IDiffStore private readonly diffStore: IDiffStore,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
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


		const byFile = new Map<string, DiffHunk[]>();
		for (const h of applied) {
			const arr = byFile.get(h.filePath) || [];
			arr.push(h);
			byFile.set(h.filePath, arr);
		}

		for (const model of this._decIds.keys()) {
			if (model.isDisposed() || !byFile.has(model.uri.fsPath)) {
				if (!model.isDisposed()) { model.deltaDecorations(this._decIds.get(model)!, []); }
				this._decIds.delete(model);
			}
		}
		for (const model of this.modelService.getModels()) {
			const hunks = byFile.get(model.uri.fsPath);
			if (model.uri.scheme === 'file' && hunks) { this._updateModel(model, hunks); }
		}
	}

	private _updateModel(model: ITextModel, hunks: DiffHunk[]): void {
		const decs: IModelDeltaDecoration[] = [];
		let count = 0;
		for (const h of hunks) {
			if (count++ >= DiffDecorator.MAX_DECORATIONS) { break; }
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
		const oldIds = this._decIds.get(model) || [];
		this._decIds.set(model, model.deltaDecorations(oldIds, decs));
	}

	override dispose(): void {
		for (const [model, ids] of this._decIds) {
			if (!model.isDisposed()) { model.deltaDecorations(ids, []); }
		}
		this._decIds.clear();
		super.dispose();
	}
}
