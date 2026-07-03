/*---------------------------------------------------------------------------------------------
 *  AI Studio — Memory Store
 *  Two-tier conversation memory: in-memory ConversationMemory + disk JSONL archive.
 *  Sessions auto-save on stop/error and auto-load on next run.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { ConversationTurn } from './conversationMemory.js';

const MAX_HISTORY_FILES = 10;

export class MemoryStore {
	constructor(
		private readonly workspaceRoot: string,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {}

	private get _historyDir(): string {
		return this.workspaceRoot + '/.ai-studio/history';
	}

	async saveSession(turns: readonly ConversationTurn[]): Promise<void> {
		if (!turns.length) return;
		try {
			const dirUri = URI.file(this._historyDir);
			await this._ensureDir(dirUri);
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			const lines = turns.map(t => JSON.stringify(t));
			const content = VSBuffer.fromString(lines.join('\n') + '\n');
			const uri = URI.file(this._historyDir + '/session-' + ts + '.jsonl');
			await this.fileService.writeFile(uri, content);
			await this._pruneOldSessions(dirUri);
		} catch (e) {
			this.logService.warn('[MemoryStore] Failed to save session:', e);
		}
	}

	async loadLastSession(): Promise<ConversationTurn[]> {
		try {
			const dirUri = URI.file(this._historyDir);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children?.length) return [];
			const sessions = stat.children
				.filter(c => c.name.endsWith('.jsonl'))
				.sort((a, b) => b.name.localeCompare(a.name));
			if (!sessions.length) return [];
			const content = (await this.fileService.readFile(URI.file(this._historyDir + '/' + sessions[0].name))).value.toString();
			return content.trim().split('\n').filter(Boolean).map(line => {
				try { return JSON.parse(line) as ConversationTurn; }
				catch { return null; }
			}).filter(Boolean) as ConversationTurn[];
		} catch {
			return [];
		}
	}

	private async _ensureDir(dirUri: URI): Promise<void> {
		try { await this.fileService.createFolder(dirUri); } catch { /* exists */ }
	}

	private async _pruneOldSessions(dirUri: URI): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) return;
			const sessions = stat.children.filter(c => c.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name));
			while (sessions.length > MAX_HISTORY_FILES) {
				const oldest = sessions.shift()!;
				await this.fileService.del(URI.file(this._historyDir + '/' + oldest.name)).catch(() => {});
			}
		} catch { /* fine */ }
	}
}
