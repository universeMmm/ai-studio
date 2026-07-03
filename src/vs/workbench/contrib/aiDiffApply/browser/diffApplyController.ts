/*---------------------------------------------------------------------------------------------
 *  AI Studio — Diff Apply Controller
 *  Handles Reject (undo) for individual hunks or all hunks in a group.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IDiffStore } from './diffStore.js';
import type { DiffHunk } from '../common/diffTypes.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { ITextModel } from '../../../../editor/common/model.js';

export class DiffApplyController extends Disposable {
	constructor(
		@IDiffStore private readonly diffStore: IDiffStore,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
	) { super(); }

	async rejectHunk(groupId: string, hunkId: string): Promise<void> {
		let target: DiffHunk | null = null;
		for (const g of this.diffStore.groups) {
			if (g.id !== groupId) continue;
			for (const h of g.hunks) { if (h.id === hunkId && h.status === 'applied') { target = h; break; } }
			break;
		}
		if (!target) return;
		await this._reverseEdit(target);
		this.diffStore.rejectHunk(groupId, hunkId);
	}

	async rejectAll(groupId: string): Promise<void> {
		let hunks: DiffHunk[] = [];
		for (const g of this.diffStore.groups) { if (g.id === groupId) { hunks = g.hunks.filter((h: any) => h.status === 'applied'); break; } }
		for (let i = hunks.length - 1; i >= 0; i--) await this._reverseEdit(hunks[i]);
		this.diffStore.rejectAll(groupId);
	}

	private async _reverseEdit(hunk: DiffHunk): Promise<void> {
		const uri = URI.file(hunk.filePath);
		for (const ed of this.editorService.visibleTextEditorControls) {
			const model = ed.getModel() as ITextModel;
			if (model?.uri?.toString() === uri.toString()) {
				model.pushEditOperations(null, [{ range: new Range(hunk.modifiedStartLine, 1, hunk.modifiedEndLine + 1, 1), text: hunk.originalText || '' }], () => null);
				return;
			}
		}
		// Fallback: file not open → replace the modified line range directly.
		const content = (await this.fileService.readFile(uri)).value.toString();
		const startOffset = this._offsetForLine(content, hunk.modifiedStartLine);
		const endOffset = this._offsetForLine(content, hunk.modifiedEndLine + 1);
		const nextContent = content.slice(0, startOffset) + (hunk.originalText || '') + content.slice(endOffset);
		await this.fileService.writeFile(uri, VSBuffer.fromString(nextContent));
	}

	private _offsetForLine(content: string, lineNumber: number): number {
		if (lineNumber <= 1) return 0;
		let currentLine = 1;
		for (let i = 0; i < content.length; i++) {
			if (content.charCodeAt(i) === 10) {
				currentLine++;
				if (currentLine === lineNumber) return i + 1;
			}
		}
		return content.length;
	}
}
