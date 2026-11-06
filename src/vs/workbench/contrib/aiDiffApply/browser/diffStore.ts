/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace edit review state.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import type { DiffEditStatus, DiffGroup, DiffHunk } from '../common/diffTypes.js';

export const IDiffStore = createDecorator<IDiffStore>('aiDiffStore');

export interface IDiffStore {
	readonly _serviceBrand: undefined;
	readonly groups: readonly DiffGroup[];
	readonly onDidChange: Event<void>;
	initialize(workspacePath: string): Promise<void>;
	whenSaved(): Promise<void>;
	addGroup(group: DiffGroup): void;
	acceptHunk(groupId: string, hunkId: string): void;
	rejectHunk(groupId: string, hunkId: string): void;
	rejectAll(groupId: string): void;
	getAppliedHunksForFile(filePath: string): DiffHunk[];
	getAllAppliedHunks(): DiffHunk[];
}

function isReviewGroup(value: Partial<DiffGroup> | null): value is DiffGroup {
	return !!value && typeof value.id === 'string' && Array.isArray(value.hunks) && value.hunks.every(h =>
		h && typeof h.id === 'string' && typeof h.filePath === 'string' && typeof h.modifiedText === 'string' &&
		typeof h.originalText === 'string' && Number.isInteger(h.modifiedStartLine) && h.modifiedStartLine > 0 &&
		['applied', 'accepted', 'rejected'].includes(h.status));
}

export class DiffStore extends Disposable implements IDiffStore {
	declare readonly _serviceBrand: undefined;
	private _groups: DiffGroup[] = [];
	private storageUri?: URI;
	private loading?: Promise<void>;
	private saving?: Promise<void>;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	get groups(): readonly DiffGroup[] { return this._groups; }

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) { super(); }

	async initialize(workspacePath: string): Promise<void> {
		if (!workspacePath) {
			this.storageUri = undefined;
			this.loading = undefined;
			this._groups = [];
			this.changed.fire();
			return;
		}
		const uri = URI.joinPath(URI.file(workspacePath), '.ai-studio', 'diffs.json');
		if (uri.toString() === this.storageUri?.toString()) { return this.loading; }
		if (this.storageUri) {
			this._groups = [];
			this.changed.fire();
		}
		this.storageUri = uri;
		// A workspace may be reopened before its previous writes have settled.
		this.loading = this.restore(uri, this._groups, this.saving);
		await this.loading;
		if (this.storageUri === uri) { this.loading = undefined; }
	}

	private async restore(uri: URI, groups: DiffGroup[], previousWrites?: Promise<void>): Promise<void> {
		try {
			if (previousWrites) { await previousWrites; }
			const file = await this.fileService.readFile(uri);
			const state = JSON.parse(file.value.toString());
			if (!Array.isArray(state?.groups)) { return; }
			const currentIds = new Set(groups.map(g => g.id));
			groups.unshift(...state.groups.filter((g: DiffGroup) => isReviewGroup(g) && !currentIds.has(g.id)));
			if (this.storageUri === uri) { this.changed.fire(); }
		} catch { /* A new workspace has no saved review state. */ }
	}

	addGroup(group: DiffGroup): void {
		this._groups.push(group);
		this.updated();
	}

	acceptHunk(groupId: string, hunkId: string): void { this.setStatus(groupId, 'accepted', hunkId); }
	rejectHunk(groupId: string, hunkId: string): void { this.setStatus(groupId, 'rejected', hunkId); }
	rejectAll(groupId: string): void { this.setStatus(groupId, 'rejected'); }

	private setStatus(groupId: string, status: DiffEditStatus, hunkId?: string): void {
		const hunks = this._groups.find(g => g.id === groupId)?.hunks.filter(h => h.status === 'applied' && (!hunkId || h.id === hunkId));
		if (!hunks?.length) { return; }
		for (const hunk of hunks) { hunk.status = status; }
		this.updated();
	}

	getAppliedHunksForFile(filePath: string): DiffHunk[] {
		return this.getAllAppliedHunks().filter(hunk => hunk.filePath === filePath);
	}

	getAllAppliedHunks(): DiffHunk[] {
		return this._groups.flatMap(group => group.hunks.filter(h => h.status === 'applied'));
	}

	async whenSaved(): Promise<void> { await this.saving; }

	private updated(): void {
		const uri = this.storageUri;
		const groups = this._groups;
		const ready = this.loading;
		this.changed.fire();
		if (!uri) { return; }
		// Mutations during startup are merged with restored groups before the first save.
		// Serialize writes so accepting edits quickly cannot restore an older status on disk.
		const save = async () => {
			if (ready) { await ready; }
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify({ groups })));
		};
		const writing = (this.saving ? this.saving.then(save) : save()).catch(error => this.logService.error('[DiffStore] Saving changes', error));
		this.saving = writing;
		void writing.then(() => { if (this.saving === writing) { this.saving = undefined; } });
	}
}
