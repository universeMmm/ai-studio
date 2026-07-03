/*---------------------------------------------------------------------------------------------
 *  AI Studio - Index Service
 *  Hybrid search: API-based semantic + ripgrep keyword. Falls back gracefully.
 *
 *  NOTE: child_process is imported dynamically to avoid static ESM
 *  resolution failures in Electron's sandboxed renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import { IFileService } from "../../../platform/files/common/files.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { IAIModelService } from "./aiModelService.js";
import type { CodeSnippet, IndexStats } from "../common/aiTypes.js";
import { IndexBuilder } from "./indexBuilder.js";

export const IAIIndexService = createDecorator<IAIIndexService>("aiIndexService");

export interface IAIIndexService {
	readonly _serviceBrand: undefined;
	readonly isReady: boolean;
	readonly onDidBecomeReady: Event<void>;
	readonly stats: IndexStats;
	search(query: string, topK: number): Promise<CodeSnippet[]>;
	reindex(): Promise<void>;
	indexFile(filePath: string): Promise<void>;
	removeFile(filePath: string): Promise<void>;
}

// --- Spawn helper (uses IPC bridge in sandboxed renderer) -------------------
async function _spawnRg(args: string[], cwd: string, timeoutMs: number): Promise<string> {
	// Try IPC bridge first (sandboxed renderer)
	try {
		const vscodeWin = (globalThis as any).vscode;
		if (vscodeWin?.ipcRenderer?.invoke) {
			const result = await vscodeWin.ipcRenderer.invoke(
				'vscode:ai-studio:exec',
				{ command: 'rg', args, cwd, timeout: timeoutMs }
			);
			if (result && typeof result === 'object') {
				if (result.exitCode === 0 || (result.code === 0)) {
					return String(result.stdout || '');
				}
				throw new Error(String(result.stderr || 'rg returned non-zero exit'));
			}
		}
	} catch (e) { throw e; }

	// Fallback: try dynamic import of child_process (works in non-sandboxed dev)
	const spawn = (await import("child_process")).spawn;
	return new Promise((resolve, reject) => {
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("rg timed out"));
		}, timeoutMs);
		child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
		child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
		child.on("close", code => {
			clearTimeout(timer);
			if (code === 0 || stdout) resolve(stdout);
			else reject(new Error(stderr || "No matches found."));
		});
		child.on("error", err => { clearTimeout(timer); reject(err); });
	});
}

export class AIIndexService extends Disposable implements IAIIndexService {
	declare readonly _serviceBrand: undefined;

	private _builder: IndexBuilder | null = null;
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	private _stats: IndexStats = { totalFiles: 0, totalChunks: 0, lastIndexedAt: 0, isReady: false };

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAIModelService private readonly modelService: IAIModelService,
	) { super(); this._init(); }

	get isReady() { return this._stats.isReady; }
	get stats() { return this._stats; }

	private async _init(): Promise<void> {
		const root = this._getRoot();
		this._builder = new IndexBuilder(root, this.fileService, this.logService, this.modelService);
		try {
			await this._builder.initialize();
			await this._builder.fullIndex();
			const s = await this._builder.getStore()?.getStats();
			this._stats = { totalFiles: s?.totalFiles ?? 0, totalChunks: s?.totalChunks ?? 0, lastIndexedAt: Date.now(), isReady: true };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			this.logService.warn("[AIIndexService] Index initialization failed: " + detail);
			this.logService.warn("[AIIndexService] Semantic search is UNAVAILABLE. The AI will use keyword-only search.");
			this.logService.warn("[AIIndexService] To enable semantic search, install: npm install @vscode/sqlite3 hnswlib-node");
			this._stats = { totalFiles: 0, totalChunks: 0, lastIndexedAt: 0, isReady: true };
		}
		this._onDidBecomeReady.fire();
	}

	async search(query: string, topK: number): Promise<CodeSnippet[]> {
		const semantic = (async () => {
			try {
				if (!this._builder?.isReady()) return [];
				const emb = await this._builder.embed(query);
				return (await this._builder.getStore()?.searchSemantic(emb, topK * 2) ?? []).map((r: any) => ({
					...r.chunk, score: r.score * 0.6,
				}));
			} catch { return []; }
		})();

		const keyword = this._keywordSearch(query, topK).then(r => r.map(s => ({ ...s, score: 0.4 })));

		const [s, k] = await Promise.all([semantic, keyword]);
		const map = new Map<string, CodeSnippet>();
		for (const x of s) map.set(x.filePath + ":" + x.startLine, x);
		for (const x of k) {
			const key = x.filePath + ":" + x.startLine;
			if (map.has(key)) {
				map.get(key)!.score += 0.4;
			} else {
				map.set(key, x);
			}
		}
		return [...map.values()].sort((a, b) => b.score - a.score).slice(0, topK);
	}

	private async _keywordSearch(query: string, topK: number): Promise<CodeSnippet[]> {
		const words = query.split(/\s+/).filter(w => w.length > 1);
		if (!words.length) return [];
		try {
			const out = await _spawnRg(["--line-number", "--max-count=" + (topK * 3), words.join("|")], this._getRoot(), 10_000);
			return out.trim().split("\n").slice(0, topK).map(line => {
				const m = line.match(/^(.+?):(\d+):(.*)$/);
				return m ? { filePath: m[1], startLine: parseInt(m[2]), endLine: parseInt(m[2]), content: m[3], score: 0.4 } : null;
			}).filter(Boolean) as CodeSnippet[];
		} catch { return []; }
	}

	async reindex(): Promise<void> {
		if (this._builder) { await this._builder.fullIndex(); this._stats.lastIndexedAt = Date.now(); }
	}
	async indexFile(fp: string): Promise<void> { await this._builder?.indexFile(fp); }
	async removeFile(fp: string): Promise<void> { await this._builder?.removeFile(fp); }

	private _getRoot(): string {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath || ".";
	}
}
