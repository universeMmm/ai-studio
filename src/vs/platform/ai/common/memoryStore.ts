/*---------------------------------------------------------------------------------------------
 *  AI Studio — Memory Store
 *  Two-tier conversation memory: in-memory ConversationMemory + disk JSONL archive.
 *  Sessions auto-save on stop/error and auto-load on next run.
 *  Extended to persist full AgentSession data (steps, plan, usage, meta).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { ConversationTurn, AgentSession, AgentStatus } from './aiTypes.js';

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

	/**
	 * @deprecated Use {@link saveSessionFull} to persist complete AgentSession data.
	 * Legacy save that writes one ConversationTurn per line.
	 */
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

	/** Persist the full AgentSession as a single JSONL line. */
	async saveSessionFull(session: AgentSession): Promise<void> {
		try {
			const dirUri = URI.file(this._historyDir);
			await this._ensureDir(dirUri);
			const content = VSBuffer.fromString(JSON.stringify(session) + '\n');
			const uri = URI.file(this._historyDir + '/session-' + session.sessionId.replace(/[:.]/g, '-') + '.jsonl');
			await this.fileService.writeFile(uri, content);
			await this._pruneOldSessions(dirUri);
			this.logService.info('[MemoryStore] Full session saved: ' + session.sessionId);
		} catch (e) {
			this.logService.warn('[MemoryStore] Failed to save full session:', e);
		}
	}

	/**
	 * Load the most recent session.
	 * Handles both new format (single-line AgentSession) and legacy format
	 * (one ConversationTurn per line).
	 */
	async loadLastSession(): Promise<AgentSession | null> {
		try {
			const dirUri = URI.file(this._historyDir);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children?.length) return null;
			const sessions = stat.children
				.filter(c => c.name.endsWith('.jsonl'))
				.sort((a, b) => b.name.localeCompare(a.name));
			if (!sessions.length) return null;
			const raw = (await this.fileService.readFile(URI.file(this._historyDir + '/' + sessions[0].name))).value.toString();
			return this._parseSession(raw, sessions[0].name);
		} catch {
			return null;
		}
	}

	/** Load a specific session by sessionId. */
	async loadSession(sessionId: string): Promise<AgentSession | null> {
		try {
			const dirUri = URI.file(this._historyDir);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children?.length) return null;
			const file = stat.children.find(c => c.name === 'session-' + sessionId.replace(/[:.]/g, '-') + '.jsonl');
			if (!file) return null;
			const raw = (await this.fileService.readFile(URI.file(this._historyDir + '/' + file.name))).value.toString();
			return this._parseSession(raw, file.name);
		} catch {
			return null;
		}
	}

	/** List all saved sessions with metadata (no full content). */
	async listSessions(): Promise<{ sessionId: string; startedAt: number; instruction: string }[]> {
		try {
			const dirUri = URI.file(this._historyDir);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children?.length) return [];
			const result: { sessionId: string; startedAt: number; instruction: string }[] = [];
			for (const child of stat.children) {
				if (!child.name.endsWith('.jsonl')) continue;
				try {
					const raw = (await this.fileService.readFile(URI.file(this._historyDir + '/' + child.name))).value.toString();
					const firstLine = raw.trim().split('\n')[0] || '';
					const parsed = JSON.parse(firstLine);
					if (parsed.sessionId) {
						// New format
						result.push({ sessionId: parsed.sessionId, startedAt: parsed.startedAt || 0, instruction: parsed.instruction || '' });
					} else {
						// Legacy format — extract sessionId from filename
						const id = child.name.replace(/^session-/, '').replace(/\.jsonl$/, '');
						result.push({ sessionId: id, startedAt: 0, instruction: '' });
					}
				} catch { /* skip corrupted files */ }
			}
			return result.sort((a, b) => b.startedAt - a.startedAt);
		} catch {
			return [];
		}
	}

	// --- Private helpers -------------------------------------------------------

	/**
	 * Parse a raw session file into an AgentSession.
	 * Detects new format (single-line AgentSession JSON with sessionId field)
	 * vs legacy format (one ConversationTurn JSON per line).
	 */
	private _parseSession(raw: string, filename: string): AgentSession | null {
		const firstLine = raw.trim().split('\n')[0] || '';
		let parsed: any;
		try { parsed = JSON.parse(firstLine); } catch { return null; }

		if (parsed.sessionId && parsed.turns) {
			// New format — full AgentSession
			return parsed as AgentSession;
		}

		// Legacy format — each line is a ConversationTurn, construct minimal AgentSession
		const turns: ConversationTurn[] = raw.trim().split('\n').filter(Boolean).map(line => {
			try { return JSON.parse(line) as ConversationTurn; }
			catch { return null; }
		}).filter(Boolean) as ConversationTurn[];

		if (!turns.length) return null;

		// Extract sessionId from filename: session-YYYY-MM-DDTHH-MM-SS-MSSZ.jsonl
		const id = filename.replace(/^session-/, '').replace(/\.jsonl$/, '');
		return {
			sessionId: id,
			startedAt: 0,
			endedAt: 0,
			instruction: turns[0]?.userMessage || '',
			steps: [],
			taskSnapshot: null,
			turns,
			status: 'stopped' as AgentStatus,
			usage: null,
			meta: { modelId: '', maxSteps: 0, maxTokens: 0 },
		};
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
