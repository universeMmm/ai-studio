/*---------------------------------------------------------------------------------------------
 *  AI Studio - Index Builder
 *  Orchestrates full + incremental code indexing.
 *  Embeddings: primary path uses the configured AI model embedding API;
 *              falls back gracefully to keyword-only search when unavailable.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Disposable } from "../../../base/common/lifecycle.js";
import { IFileService } from "../../../platform/files/common/files.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { IAIModelService } from "./aiModelService.js";
import { IndexStore } from "../common/indexStore.js";
import { chunkFile } from "../common/chunker.js";

/**
 * Inline path polyfill — the sandboxed renderer cannot access Node.js "path".
 */
const _sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
const _isWin = _sep === '\\';

function _normalizePath(p: string): string {
	if (!p) return '.';
	let isAbs = false;
	let prefix = '';
	if (_isWin) {
		const m = p.match(/^([a-zA-Z]:)([\\/]?)/);
		if (m) { prefix = m[1]; p = p.slice(m[0].length); isAbs = true; }
	} else if (p.startsWith('/')) {
		isAbs = true;
	}
	const parts = p.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.');
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '..') { resolved.pop(); continue; }
		resolved.push(part);
	}
	let result = resolved.join('/');
	if (_isWin) {
		result = prefix + (result ? '\\' + result.replace(/\//g, '\\') : '\\');
	} else if (isAbs) {
		result = '/' + result;
	}
	return result || (isAbs ? (_isWin ? prefix + '\\' : '/') : '.');
}

function _join(...segments: string[]): string {
	return _normalizePath(segments.filter(Boolean).join('/'));
}

function _isAbsolute(p: string): boolean {
	if (_isWin) return /^[a-zA-Z]:[\\/]/.test(p);
	return p.startsWith('/');
}

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILE_LINES = 1000;

export class IndexBuilder extends Disposable {
	private __store: IndexStore | null = null;
	private _embeddingAvailable = false;
	private _isIndexing = false;

	constructor(
		private readonly workspaceRoot: string,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IAIModelService private readonly modelService: IAIModelService,
	) { super(); }

	async initialize(): Promise<void> {
		this.__store = new IndexStore(this.workspaceRoot);
		await this.__store.initialize();
		try {
			const embeddings = await this.modelService.embed(["test probe"]);
			if (embeddings.length > 0 && embeddings[0].some((v: number) => v !== 0)) {
				this._embeddingAvailable = true;
				this.logService.info("[IndexBuilder] Embedding API available. Semantic search enabled.");
			}
		} catch {
			this.logService.warn("[IndexBuilder] Embedding API unavailable - keyword-only search.");
		}
	}

	async fullIndex(): Promise<void> {
		if (!this.__store || this._isIndexing) return;
		this._isIndexing = true;
		const files = await this._collectFiles();
		for (const f of files) { await this._indexOne(f); }
		this._isIndexing = false;
	}

	async indexFile(fp: string): Promise<void> { await this._indexOne(fp); }

	async removeFile(fp: string): Promise<void> { await this.__store?.removeFile(fp); }

	getStore() { return this.__store; }
	isReady() { return this.__store !== null && this._embeddingAvailable; }

	async embed(text: string): Promise<Float32Array> {
		if (!this._embeddingAvailable) throw new Error("Embeddings not available");
		const embeddings = await this.modelService.embed([text]);
		if (!embeddings.length || embeddings[0].every((v: number) => v === 0)) {
			throw new Error("Empty embedding returned");
		}
		return new Float32Array(embeddings[0]);
	}

	private async _indexOne(fp: string): Promise<void> {
		if (!this.__store) return;
		const fullPath = _isAbsolute(fp) ? fp : _join(this.workspaceRoot, fp);
		try {
			await this.__store.removeFile(fullPath);
			const text = (await this.fileService.readFile(URI.file(fullPath))).value.toString();
			if (text.length > MAX_FILE_SIZE || text.split("\n").length > MAX_FILE_LINES) return;
			const chunks = chunkFile(fullPath, text, _extToLang(fullPath));
			for (const c of chunks) {
				let embedding: Float32Array | null = null;
				if (this._embeddingAvailable) {
					try { embedding = await this.embed(c.content); } catch { /* skip chunk */ }
				}
				if (embedding) {
					await this.__store.add(c.id, { filePath: c.filePath, startLine: c.startLine, endLine: c.endLine, content: c.content, kind: c.kind, name: c.name, }, embedding);
				}
			}
		} catch (err) {
			this.logService.error("[IndexBuilder] " + fullPath + ": " + (err instanceof Error ? err.message : String(err)));
		}
	}

	private async _collectFiles(): Promise<string[]> {
		try {
			const { execSync } = await import("child_process");
			return String(execSync("rg --files --no-ignore-vcs", {
				cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024,
				encoding: "utf-8", timeout: 30000,
			})).trim().split("\n").filter(Boolean);
		} catch { return []; }
	}
}

function _extToLang(fp: string): string {
	const ext = fp.split(".").pop()?.toLowerCase() || "";
	const m: Record<string, string> = { ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp", rb: "ruby", };
	return m[ext] || ext;
}
