/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Index Service
 *  Hybrid search: API-based semantic + ripgrep keyword. Falls back gracefully.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IAIModelService } from './aiModelService.js';
import type { CodeSnippet, IndexStats } from '../common/aiTypes.js';
import { isAbsolute, relative, resolve } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { runIndexRipgrep } from './indexRipgrep.js';
import { IndexBuilder } from './indexBuilder.js';

export const IAIIndexService = createDecorator<IAIIndexService>('aiIndexService');

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

interface WorkspaceIndex {
	builder: IndexBuilder;
	initialized: Promise<void>;
	firstScan: Promise<void>;
}

export class AIIndexService extends Disposable implements IAIIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly indexes = new Map<string, WorkspaceIndex>();
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	private ready = false;
	private lastIndexedAt = 0;
	private generation = 0;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAIModelService private readonly modelService: IAIModelService,
	) {
		super();
		void this.syncFolders();
		if (this.workspaceContextService.onDidChangeWorkspaceFolders) {
			this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => { void this.syncFolders(); }));
		}
	}

	get isReady(): boolean { return this.ready; }
	get stats(): IndexStats {
		let totalFiles = 0;
		let totalChunks = 0;
		for (const { builder } of this.indexes.values()) {
			const stats = builder.getStore()?.stats;
			totalFiles += stats?.totalFiles ?? 0;
			totalChunks += stats?.totalChunks ?? 0;
		}
		return { totalFiles, totalChunks, lastIndexedAt: this.lastIndexedAt, isReady: this.ready };
	}

	private async syncFolders(): Promise<void> {
		const generation = ++this.generation;
		const folders = this.workspaceContextService.getWorkspace().folders;
		const roots = new Set(folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath));
		for (const [root, { builder }] of this.indexes) {
			if (!roots.has(root)) { builder.dispose(); this.indexes.delete(root); }
		}
		this.ready = false;
		for (const root of roots) {
			if (this.indexes.has(root)) { continue; }
			const builder = new IndexBuilder(root, this.fileService, this.logService, this.modelService);
			const initialized = builder.initialize();
			const firstScan = initialized.then(() => builder.fullIndex()).catch(error => {
				this.logService.warn('[AIIndexService] Cannot build index for ' + root, error);
			});
			this.indexes.set(root, { builder, initialized, firstScan });
		}
		await Promise.all([...this.indexes.values()].map(index => index.firstScan));
		if (generation === this.generation) {
			this.ready = true;
			this.lastIndexedAt = Date.now();
			this._onDidBecomeReady.fire();
		}
	}

	async search(query: string, topK: number): Promise<CodeSnippet[]> {
		if (!query.trim() || topK <= 0) { return []; }
		const indexes = [...this.indexes.values()];
		const multiRoot = indexes.length > 1;
		const matches = new Map<string, CodeSnippet>();
		const indexed = indexes.find(({ builder }) => builder.isReady() && builder.getStore()?.stats.totalChunks);
		const semantic = indexed ? indexed.builder.embed(query).then(async embedding => {
			const hits = await Promise.all(indexes.filter(({ builder }) => builder.isReady())
				.map(({ builder }) => builder.getStore()!.searchSemantic(embedding, topK)));
			return hits.flat().map(({ chunk, score }) => ({ ...chunk, score: score * 0.6 }));
		}).catch(() => []) : Promise.resolve([]);
		const keyword = Promise.all(indexes.map(({ builder }) => this.keywordSearch(builder.workspaceRoot, query, topK)));
		const [vectors, lines] = await Promise.all([semantic, keyword]);
		for (const snippet of [...vectors, ...lines.flat()]) {
			const key = snippet.filePath + ':' + snippet.startLine;
			const existing = matches.get(key);
			if (existing) { existing.score += snippet.score; } else { matches.set(key, snippet); }
		}
		const results = [...matches.values()].sort((a, b) => b.score - a.score).slice(0, topK);
		return multiRoot ? results : results.map(item => ({ ...item, filePath: relative(indexes[0].builder.workspaceRoot, item.filePath) }));
	}

	private async keywordSearch(root: string, query: string, topK: number): Promise<CodeSnippet[]> {
		const words = query.split(/\s+/).filter(word => word.length > 1);
		if (!words.length) { return []; }
		try {
			const args = ['--with-filename', '--line-number', '--fixed-strings', '--max-count=' + topK, '--glob', '!**/node_modules/**'];
			for (const word of words) { args.push('-e', word); }
			args.push('--', '.');
			const output = await runIndexRipgrep(args, root);
			const matches: CodeSnippet[] = [];
			for (const line of output.split('\n')) {
				const match = /^(.+?):(\d+):(.*)$/.exec(line);
				if (match) {
					const lineNumber = Number(match[2]);
					matches.push({ filePath: resolve(root, match[1]), startLine: lineNumber, endLine: lineNumber, content: match[3], score: 0.4 });
					if (matches.length === topK) { break; }
				}
			}
			return matches;
		} catch (error) {
			this.logService.warn('[AIIndexService] Cannot search ' + root, error);
			return [];
		}
	}

	async reindex(): Promise<void> {
		await Promise.all([...this.indexes.values()].map(async ({ builder, firstScan }) => {
			await firstScan;
			await builder.fullIndex(true);
		}));
		this.lastIndexedAt = Date.now();
	}

	private indexFor(path: string): WorkspaceIndex | undefined {
		const primary = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!isAbsolute(path)) { return primary ? this.indexes.get(primary) : undefined; }
		return [...this.indexes.values()].filter(({ builder }) => builder.contains(path))
			.sort((a, b) => b.builder.workspaceRoot.length - a.builder.workspaceRoot.length)[0];
	}

	async indexFile(path: string): Promise<void> {
		const index = this.indexFor(path);
		if (index) {
			await index.initialized;
			await index.builder.indexFile(path);
			this.lastIndexedAt = Date.now();
		}
	}

	async removeFile(path: string): Promise<void> {
		const index = this.indexFor(path);
		if (index) {
			await index.initialized;
			await index.builder.removeFile(path);
			this.lastIndexedAt = Date.now();
		}
	}

	override dispose(): void {
		this.generation++;
		for (const { builder } of this.indexes.values()) { builder.dispose(); }
		this.indexes.clear();
		super.dispose();
	}
}
