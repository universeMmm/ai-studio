/*---------------------------------------------------------------------------------------------
 *  AI Studio - Diff Store
 *  Central state management for all pending diff hunks.
 *  Persists to .ai-studio/diffs.json so pending diffs survive restarts.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import type { DiffGroup, DiffHunk } from "../common/diffTypes.js";

export const IDiffStore = createDecorator<IDiffStore>("aiDiffStore");

export interface IDiffStore {
	readonly _serviceBrand: undefined;
	readonly groups: readonly DiffGroup[];
	readonly onDidChange: Event<void>;
	initialize(workspacePath: string): Promise<void>;
	addGroup(group: DiffGroup): void;
	rejectHunk(groupId: string, hunkId: string): void;
	rejectAll(groupId: string): void;
	getAppliedHunksForFile(filePath: string): DiffHunk[];
	getAllAppliedHunks(): DiffHunk[];
}

interface PersistedState {
	groups: DiffGroup[];
}

export class DiffStore extends Disposable implements IDiffStore {
	declare readonly _serviceBrand: undefined;

	private _groups: DiffGroup[] = [];
	private _storageUri: URI | null = null;
	private _initialized = false;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	get groups(): readonly DiffGroup[] { return this._groups; }

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) { super(); }

	async initialize(workspacePath: string): Promise<void> {
		this._storageUri = URI.file(workspacePath + "/.ai-studio/diffs.json");
		this._initialized = true;

		// Restore persisted state
		try {
			const content = await this.fileService.readFile(this._storageUri);
			const state: PersistedState = JSON.parse(content.value.toString());
			if (state.groups?.length) {
				this._groups = state.groups;
				this._onDidChange.fire();
				this.logService.info("[DiffStore] Restored " + state.groups.length + " diff group(s).");
			}
		} catch {
			// No saved state - that''s fine on first run
		}
	}

	addGroup(group: DiffGroup): void {
		this._groups.push(group);
		this._onDidChange.fire();
		this._persist();
	}

	rejectHunk(groupId: string, hunkId: string): void {
		for (const g of this._groups) {
			if (g.id !== groupId) continue;
			let changed = false;
			for (const h of g.hunks) {
				if (h.id === hunkId && h.status === "applied") {
					h.status = "rejected";
					changed = true;
				}
			}
			if (changed) {
				this._onDidChange.fire();
				this._persist();
			}
			return;
		}
	}

	rejectAll(groupId: string): void {
		for (const g of this._groups) {
			if (g.id !== groupId) continue;
			let changed = false;
			for (const h of g.hunks) {
				if (h.status === "applied") {
					h.status = "rejected";
					changed = true;
				}
			}
			if (changed) {
				this._onDidChange.fire();
				this._persist();
			}
			return;
		}
	}

	getAppliedHunksForFile(filePath: string): DiffHunk[] {
		const r: DiffHunk[] = [];
		for (const g of this._groups) {
			for (const h of g.hunks) {
				if (h.filePath === filePath && h.status === "applied") r.push(h);
			}
		}
		return r;
	}

	getAllAppliedHunks(): DiffHunk[] {
		const r: DiffHunk[] = [];
		for (const g of this._groups) {
			for (const h of g.hunks) {
				if (h.status === "applied") r.push(h);
			}
		}
		return r;
	}

	private _persist(): void {
		if (!this._initialized || !this._storageUri) return;
		const state: PersistedState = { groups: this._groups };
		this.fileService.writeFile(this._storageUri, VSBuffer.fromString(JSON.stringify(state, null, 2)))
			.catch(err => this.logService.error("[DiffStore] Failed to persist diffs:", err));
	}
}
