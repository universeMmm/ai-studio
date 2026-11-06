/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Review changes that have already been written to the workspace.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { extUri, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { Queue } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IDiffStore } from './diffStore.js';
import type { DiffHunk } from '../common/diffTypes.js';

export const IDiffApplyController = createDecorator<DiffApplyController>('aiDiffApplyController');
const conflict = () => new Error('文件已发生变化。请打开文件，核对当前内容后再撤销。');

function originalContent(content: string, hunk: DiffHunk): string {
	if (hunk.kind === 'write') {
		if (content !== hunk.modifiedText) { throw conflict(); }
		return hunk.originalText;
	}

	let start = 0;
	for (let line = 1; line < hunk.modifiedStartLine; line++) {
		const newline = content.indexOf('\n', start);
		if (newline === -1) { throw conflict(); }
		start = newline + 1;
	}
	const lineEnd = content.indexOf('\n', start);
	const end = lineEnd === -1 ? content.length : lineEnd;
	if (hunk.modifiedStartColumn !== undefined) {
		if (hunk.modifiedStartColumn < 1 || start + hunk.modifiedStartColumn - 1 > end) { throw conflict(); }
		start += hunk.modifiedStartColumn - 1;
	} else {
		// Legacy changes recorded a line but no column. Only undo an unambiguous match on that line.
		if (!hunk.modifiedText) { throw conflict(); }
		const match = content.indexOf(hunk.modifiedText, start);
		const another = content.indexOf(hunk.modifiedText, match + 1);
		if (match < 0 || match > end || (another >= 0 && another <= end)) { throw conflict(); }
		start = match;
	}
	if (!content.startsWith(hunk.modifiedText, start)) { throw conflict(); }
	if (hunk.beforeAnchor !== undefined && !content.slice(0, start).endsWith(hunk.beforeAnchor)) { throw conflict(); }
	if (hunk.afterAnchor !== undefined && !content.startsWith(hunk.afterAnchor, start + hunk.modifiedText.length)) { throw conflict(); }
	return content.slice(0, start) + hunk.originalText + content.slice(start + hunk.modifiedText.length);
}

export class DiffApplyController extends Disposable {
	declare readonly _serviceBrand: undefined;
	private readonly edits = this._register(new Queue<void>());

	constructor(
		@IDiffStore private readonly store: IDiffStore,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { super(); }

	acceptHunk(groupId: string, hunkId: string): Promise<void> {
		return this.edits.queue(async () => this.store.acceptHunk(groupId, hunkId));
	}

	rejectHunk(groupId: string, hunkId: string): Promise<void> {
		return this.edits.queue(() => this.rejectOne(groupId, hunkId));
	}

	rejectAll(groupId: string): Promise<void> {
		return this.edits.queue(async () => {
			const group = this.store.groups.find(g => g.id === groupId);
			if (group) {
				for (const hunk of [...group.hunks].reverse()) { await this.rejectOne(groupId, hunk.id); }
			}
		});
	}

	private async rejectOne(groupId: string, hunkId: string): Promise<void> {
		const hunk = this.store.groups.find(g => g.id === groupId)?.hunks.find(h => h.id === hunkId && h.status === 'applied');
		if (!hunk) { return; }
		const { uri, editorResources } = await this.resolveWorkspaceFile(URI.file(resolve(hunk.filePath)));
		const isDirty = () => editorResources.some(resource => this.textFiles.isDirty(resource));
		if (isDirty()) { throw new Error('请先保存文件中的编辑，再撤销助手的变更。'); }

		const file = await this.files.readFile(uri);
		if (isDirty()) { throw conflict(); }
		const content = file.value.toString();
		if (hunk.kind === 'create') {
			if (content !== hunk.modifiedText) { throw conflict(); }
			// Capture the file before deleting. A concurrent replacement at its original path
			// must survive even when it has the same size as the agent's version.
			const captured = URI.joinPath(uri, '..', '.ai-studio-review-' + generateUuid());
			await this.files.move(uri, captured, false);
			try {
				const latest = await this.files.readFile(captured);
				if (!latest.value.equals(file.value) || isDirty()) { throw conflict(); }
				await this.files.del(captured, { useTrash: this.files.hasCapability(captured, FileSystemProviderCapabilities.Trash) });
			} catch (error) {
				try { await this.files.move(captured, uri, false); }
				catch { throw new Error('文件在撤销期间发生变化。原文件保存在 ' + captured.fsPath); }
				throw error;
			}
		} else {
			const previous = originalContent(content, hunk);
			await this.files.writeFile(uri, VSBuffer.fromString(previous), { etag: file.etag, mtime: file.mtime });
		}
		this.store.rejectHunk(groupId, hunkId);
	}

	private async resolveWorkspaceFile(resource: URI): Promise<{ uri: URI; editorResources: URI[] }> {
		const roots = this.workspace.getWorkspace().folders.map(folder => folder.uri);
		const canonicalPath = async (uri: URI) => {
			const canonical = await this.files.realpath(uri);
			if (!canonical || canonical.scheme !== 'file') { throw new Error('无法验证文件的真实路径，不能撤销变更。'); }
			return canonical;
		};
		const [uri, ...canonicalRoots] = await Promise.all([canonicalPath(resource), ...roots.map(canonicalPath)]);
		const identity = isWindows ? extUriIgnorePathCase : extUri;
		const editorResources = [resource, uri];
		let inside = false;
		for (let i = 0; i < roots.length; i++) {
			if (identity.isEqualOrParent(uri, canonicalRoots[i])) {
				inside = true;
				// Editors may use the workspace alias while tools record the canonical path.
				const relative = identity.relativePath(canonicalRoots[i], uri);
				if (relative !== undefined) { editorResources.push(URI.joinPath(roots[i], relative)); }
			}
		}
		if (!inside) { throw new Error('该文件位于当前工作区之外。'); }
		return { uri, editorResources };
	}
}
