/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { RunOnceScheduler, Sequencer } from '../../../base/common/async.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IFileService, type FileChangesEvent } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IAIModelService } from './aiModelService.js';
import type { CodeSnippet, IndexStats } from '../common/aiTypes.js';
import { basename, isAbsolute, relative, resolve } from '../../../base/common/path.js';
import { match as globMatch } from '../../../base/common/glob.js';
import { Schemas } from '../../../base/common/network.js';
import { isSensitiveFile } from '../common/sensitiveFiles.js';
import { runIndexRipgrep } from './indexRipgrep.js';
import { IndexBuilder } from './indexBuilder.js';
import { getIndexOptions } from './indexOptions.js';

export const IAIIndexService = createDecorator<IAIIndexService>('aiIndexService');
export interface IAIIndexService {
	readonly _serviceBrand: undefined;
	readonly isReady: boolean;
	readonly onDidBecomeReady: Event<void>;
	readonly onDidChangeStats: Event<void>;
	readonly stats: IndexStats;
	search(query: string, topK: number, signal?: AbortSignal): Promise<CodeSnippet[]>;
	reindex(): Promise<void>;
	cancel(): void;
	indexFile(filePath: string): Promise<void>;
	removeFile(filePath: string): Promise<void>;
}
interface WorkspaceIndex { builder: IndexBuilder; initialized?: Promise<void> }

export class AIIndexService extends Disposable implements IAIIndexService {
	declare readonly _serviceBrand: undefined;
	private readonly indexes = new Map<string, WorkspaceIndex>();
	private readonly watchers = this._register(new DisposableStore());
	private readonly queue = new Sequencer();
	private readonly pending = new Map<string, 'update' | 'delete'>();
	private rescan = false;
	private changesRunning = false;
	private readonly debounce = this._register(new RunOnceScheduler(() => this.flushChanges(), 300));
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	private readonly _onDidChangeStats = this._register(new Emitter<void>());
	readonly onDidChangeStats = this._onDidChangeStats.event;
	private ready = false;
	private enabled = false;
	private paused = false;
	private disposed = false;
	private state: IndexStats['state'] = 'idle';
	private lastIndexedAt = 0;
	private generation = 0;
	private cancellation = 0;
	private searchController = new AbortController();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAIModelService private readonly modelService: IAIModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.syncFolders()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (['ai.index', 'files.exclude', 'search.exclude', 'ai.apiType', 'ai.apiBase'].some(key => event.affectsConfiguration(key))) { this.syncFolders(); }
		}));
		this._register(this.fileService.onDidFilesChange(event => this.filesChanged(event)));
		this.syncFolders();
	}

	get isReady(): boolean { return this.ready; }
	get stats(): IndexStats {
		let totalFiles = 0, totalChunks = 0, processed = 0, total = 0;
		let limited = false;
		let memoryBytes = 0, memoryLimitBytes = 0;
		let memoryLimited = false;
		for (const { builder } of this.indexes.values()) {
			const stats = builder.getStore()?.stats;
			totalFiles += stats?.totalFiles ?? 0;
			totalChunks += stats?.totalChunks ?? 0;
			processed += builder.progress.processed;
			total += builder.progress.total;
			limited ||= builder.progress.limited;
			memoryBytes += builder.getStore()?.memory.bytes ?? 0;
			memoryLimitBytes += builder.options.maxMemoryMB * 1024 * 1024;
			memoryLimited ||= builder.progress.memoryLimited;
		}
		return { totalFiles, totalChunks, lastIndexedAt: this.lastIndexedAt, isReady: this.ready, enabled: this.enabled, state: this.state, processed, total, limited, memoryBytes, memoryLimitBytes, memoryLimited };
	}

	private roots(): string[] { return this.workspaceContextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath); }
	private syncFolders(): void {
		this.searchController.abort(); this.searchController = new AbortController();
		this.generation++;
		this.watchers.clear();
		this.debounce.cancel();
		this.pending.clear(); this.rescan = false;
		for (const { builder } of this.indexes.values()) { builder.dispose(); }
		this.indexes.clear();
		this.ready = false;
		this.paused = false;
		this.enabled = this.configurationService.getValue<boolean>('ai.index.enabled') !== false;
		this.state = this.enabled ? 'idle' : 'disabled';
		if (this.enabled) {
			for (const root of this.roots()) {
				const options = getIndexOptions(this.configurationService, root);
				const builder = new IndexBuilder(root, options, () => this._onDidChangeStats.fire(), this.fileService, this.logService, this.modelService);
				this.indexes.set(root, { builder });
				this.watchers.add(this.fileService.watch(URI.file(root), { recursive: true, excludes: ['**/.ai-studio/**', '**/node_modules/**'] }));
			}
			void this.reindex();
		}
		this._onDidChangeStats.fire();
	}

	private filesChanged(event: FileChangesEvent): void {
		if (!this.enabled || this.paused || this.disposed) { return; }
		const added = new Set(event.rawAdded.map(uri => uri.toString()));
		for (const uri of [...event.rawAdded, ...event.rawUpdated]) {
			if (uri.scheme !== Schemas.file) { continue; }
			const index = this.indexFor(uri.fsPath);
			if (!index) { continue; }
			if (['.gitignore', '.ignore', '.rgignore'].includes(basename(uri.fsPath)) || uri.path.endsWith('/.git/info/exclude')) { this.rescan = true; }
			if (index.builder.accepts(uri.fsPath)) { this.pending.set(uri.fsPath, 'update'); }
			else if (added.has(uri.toString()) && !index.builder.excludes(uri.fsPath)) { this.rescan = true; }
		}
		for (const uri of event.rawDeleted) {
			if (uri.scheme !== Schemas.file || !this.indexFor(uri.fsPath)) { continue; }
			if (['.gitignore', '.ignore', '.rgignore'].includes(basename(uri.fsPath)) || uri.path.endsWith('/.git/info/exclude')) { this.rescan = true; }
			if (!this.indexFor(uri.fsPath)!.builder.excludes(uri.fsPath)) { this.pending.set(uri.fsPath, 'delete'); }
		}
		if (this.pending.size > 2000) { this.pending.clear(); this.rescan = true; }
		if (this.pending.size || this.rescan) { this.debounce.schedule(); }
	}

	private flushChanges(): void {
		if (!this.enabled || this.paused || this.disposed || this.changesRunning) { return; }
		this.changesRunning = true;
		const changes = new Map(this.pending);
		const rescan = this.rescan;
		this.pending.clear(); this.rescan = false;
		void this.run(async ({ builder }) => {
			if (rescan || builder.progress.limited && [...changes.values()].includes('delete')) { await builder.fullIndex(); return; }
			const updates: string[] = [];
			for (const [path, type] of changes) {
				if (!builder.contains(path)) { continue; }
				if (type === 'delete') { await builder.removeFile(path); } else { updates.push(path); }
			}
			if (updates.length) { await builder.updateFiles(updates); }
		}).finally(() => {
			this.changesRunning = false;
			if (!this.disposed && (this.pending.size || this.rescan)) { this.debounce.schedule(); }
		});
	}

	/** Serialize roots as well as event batches: at most one background embedding request is active. */
	private run(action: (index: WorkspaceIndex) => Promise<void>, resume = false): Promise<void> {
		const generation = this.generation;
		const cancellation = this.cancellation;
		return this.queue.queue(async () => {
			if (generation !== this.generation || cancellation !== this.cancellation || this.disposed || !this.enabled || this.paused && !resume) { return; }
			if (resume) { this.paused = false; for (const { builder } of this.indexes.values()) { builder.resume(); } }
			this.state = 'indexing'; this._onDidChangeStats.fire();
			let failed = false;
			for (const index of this.indexes.values()) {
				try {
					await (index.initialized ??= index.builder.initialize().catch(error => { index.initialized = undefined; throw error; }));
					if (generation !== this.generation || this.paused) { return; }
					await action(index);
				} catch (error) {
					if (generation !== this.generation || this.paused || this.disposed) { return; }
					failed = true;
					this.logService.warn('[AIIndexService] Index update failed; keyword search remains available', error);
				}
			}
			if (generation !== this.generation || this.paused || this.disposed) { return; }
			this.state = failed ? 'error' : 'idle';
			this.ready = true;
			if (!failed) { this.lastIndexedAt = Date.now(); }
			this._onDidChangeStats.fire(); this._onDidBecomeReady.fire();
		});
	}

	async search(query: string, topK: number, cancellation?: AbortSignal): Promise<CodeSnippet[]> {
		const signal = cancellation ? AbortSignal.any([cancellation, this.searchController.signal]) : this.searchController.signal;
		signal.throwIfAborted();
		if (!query.trim() || topK <= 0) { return []; }
		const indexes = [...this.indexes.values()];
		const roots = this.roots();
		const multiRoot = roots.length > 1;
		const matches = new Map<string, CodeSnippet>();
		const indexed = indexes.find(({ builder }) => this.enabled && !this.paused && builder.isReady() && builder.getStore()?.stats.totalChunks);
		const semantic = indexed ? indexed.builder.embed(query, signal).then(async embedding => {
			const hits = await Promise.all(indexes.filter(({ builder }) => builder.isReady())
				.map(({ builder }) => builder.getStore()!.searchSemantic(embedding, topK, signal)));
			return hits.flat().map(({ chunk, score }) => ({ ...chunk, score: score * 0.6 }));
		}).catch(() => { signal.throwIfAborted(); return []; }) : Promise.resolve([]);
		const keyword = Promise.all(roots.map(root => this.keywordSearch(root, query, topK, signal)));
		const [vectors, lines] = await Promise.all([semantic, keyword]);
		signal.throwIfAborted();
		for (const snippet of [...vectors, ...lines.flat()]) {
			const key = snippet.filePath + ':' + snippet.startLine;
			const existing = matches.get(key);
			if (existing) { existing.score += snippet.score; } else { matches.set(key, snippet); }
		}
		const results = [...matches.values()].sort((a, b) => b.score - a.score).slice(0, topK);
		return multiRoot ? results : results.map(item => ({ ...item, filePath: relative(roots[0], item.filePath) }));
	}

	private async keywordSearch(root: string, query: string, topK: number, signal: AbortSignal): Promise<CodeSnippet[]> {
		const words = query.split(/\s+/).filter(word => word.length > 1);
		if (!words.length) { return []; }
		try {
			const builder = this.indexes.get(root)?.builder;
			const canUseSnapshot = () => this.enabled && !this.paused && this.state === 'idle' && !this.pending.size && !this.rescan && !this.changesRunning && builder?.isReady() && !builder.progress.limited && !builder.progress.memoryLimited;
			if (builder && canUseSnapshot()) {
				const cached = await builder.getStore()?.searchKeywords(words, topK, signal, builder.candidateCount);
				// A watcher event or concurrent update invalidates the snapshot. Limited,
				// oversized and legacy indexes keep the live full-tree ripgrep fallback.
				if (cached !== undefined && canUseSnapshot()) { return cached; }
			}
			const options = getIndexOptions(this.configurationService, root);
			const args = ['--with-filename', '--line-number', '--fixed-strings', '--hidden', '--max-count=' + topK];
			for (const pattern of options.exclude) { args.push('--glob', '!' + pattern); }
			for (const word of words) { args.push('-e', word); }
			args.push('--', '.');
			const output = await runIndexRipgrep(args, root, signal);
			const matches: CodeSnippet[] = [];
			for (const line of output.split('\n')) {
				const match = /^(.+?):(\d+):(.*)$/.exec(line);
				if (match && options.include.some(pattern => globMatch(pattern, match[1].replace(/\\/g, '/').replace(/^\.\//, ''))) && !isSensitiveFile(match[1])) {
					const lineNumber = Number(match[2]);
					matches.push({ filePath: resolve(root, match[1]), startLine: lineNumber, endLine: lineNumber, content: match[3], score: 0.4 });
					if (matches.length === topK) { break; }
				}
			}
			return matches;
		} catch (error) {
			signal.throwIfAborted();
			this.logService.warn('[AIIndexService] Cannot search ' + root, error);
			return [];
		}
	}

	/** Rescan incrementally, or resume a cancelled/failed scan from committed fingerprints. */
	reindex(): Promise<void> {
		this.debounce.cancel(); this.pending.clear(); this.rescan = false;
		return this.run(index => index.builder.fullIndex(), true);
	}
	cancel(): void {
		if (!this.enabled || this.disposed) { return; }
		this.cancellation++;
		this.searchController.abort(); this.searchController = new AbortController();
		this.paused = true; this.state = 'cancelled'; this.ready = false;
		this.debounce.cancel(); this.pending.clear(); this.rescan = false;
		for (const { builder } of this.indexes.values()) { builder.cancel(); }
		this._onDidChangeStats.fire();
	}
	private indexFor(path: string): WorkspaceIndex | undefined {
		if (!isAbsolute(path)) { return this.indexes.get(this.roots()[0]); }
		return [...this.indexes.values()].filter(({ builder }) => builder.contains(path)).sort((a, b) => b.builder.workspaceRoot.length - a.builder.workspaceRoot.length)[0];
	}
	indexFile(path: string): Promise<void> {
		const target = this.indexFor(path);
		return this.run(async index => { if (index === target) { await index.builder.indexFile(path); } });
	}
	removeFile(path: string): Promise<void> {
		const target = this.indexFor(path);
		return this.run(async index => { if (index === target) { await index.builder.removeFile(path); } });
	}
	override dispose(): void {
		this.searchController.abort();
		this.disposed = true; this.generation++;
		for (const { builder } of this.indexes.values()) { builder.dispose(); }
		this.indexes.clear();
		super.dispose();
	}
}
