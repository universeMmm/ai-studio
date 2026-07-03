/*---------------------------------------------------------------------------------------------
 *  AI Studio — Test Mock Factory
 *  Typed mock implementations of all AI service interfaces.
 *  Use these instead of hand-written `as any` mocks — constructor signature
 *  changes will cause compile-time errors here, not silent test failures.
 *--------------------------------------------------------------------------------------------*/

import type { IAIModelService } from '../../../src/vs/platform/ai/browser/aiModelService.js';
import type { IAIIndexService } from '../../../src/vs/platform/ai/browser/aiIndexService.js';
import type { IAIContextService, BuildContextInput } from '../../../src/vs/platform/ai/browser/aiContextService.js';
import type { AIMessage, AITool, AIRequestOptions, AIStreamCallbacks, AICompletionOptions, AICompletionCallbacks, FileContext, AIModel, CodeSnippet } from '../../../src/vs/platform/ai/common/aiTypes.js';
import type { IFileService } from '../../../src/vs/platform/files/common/files.js';
import type { ILogService } from '../../../src/vs/platform/log/common/log.js';
import type { IConfigurationService } from '../../../src/vs/platform/configuration/common/configuration.js';
import type { IDiffStore } from '../../../src/vs/workbench/contrib/aiDiffApply/browser/diffStore.js';
import type { IMarkerService } from '../../../src/vs/platform/markers/common/markers.js';
import type { IWorkspaceContextService } from '../../../src/vs/platform/workspace/common/workspace.js';
import { Emitter } from '../../../src/vs/base/common/event.js';

// ── AI Model Service ──────────────────────────────────────────

export class MockAIModelService implements IAIModelService {
	declare readonly _serviceBrand: undefined;
	currentProviderId: 'openai' = 'openai';
	currentModelId = 'mock-model';
	currentModelName = 'Mock Model';

	private _script: Array<{ type: string; toolName?: string; toolInput?: Record<string, unknown>; text?: string }> = [];
	private _turn = 0;

	setScript(script: Array<{ type: string; toolName?: string; toolInput?: Record<string, unknown>; text?: string }>): void {
		this._script = script;
		this._turn = 0;
	}

	streamChat(_messages: AIMessage[], _tools: AITool[], _options: AIRequestOptions, callbacks: AIStreamCallbacks): AbortController {
		const action = this._script[this._turn++] || { type: 'end_turn' as const };
		if (action.type === 'end_turn') {
			setTimeout(() => callbacks.onDone('end_turn'), 1);
		} else if (action.type === 'tool_use') {
			setTimeout(() => {
				callbacks.onToolUse(action.toolName || 'read_file', action.toolInput || {}, 'call_1');
				callbacks.onDone('tool_use');
			}, 1);
		} else if (action.type === 'error') {
			setTimeout(() => callbacks.onError(new Error('mock error')), 1);
		} else if (action.type === 'text') {
			setTimeout(() => {
				callbacks.onToken(action.text || '');
				callbacks.onDone('end_turn');
			}, 1);
		}
		return new AbortController();
	}

	streamCompletion(_prefix: string, _suffix: string, _fc: FileContext, _opts: AICompletionOptions, callbacks: AICompletionCallbacks): AbortController {
		setTimeout(() => callbacks.onDone(''), 1);
		return new AbortController();
	}

	async embed(_texts: string[]): Promise<number[][]> { return [[0.1, 0.2, 0.3]]; }
	async listModels(): Promise<AIModel[]> { return [{ id: 'mock', name: 'Mock', maxTokens: 1000, supportsThinking: false, supportsPromptCaching: false }]; }
}

// ── Index Service ─────────────────────────────────────────────

export class MockAIIndexService implements IAIIndexService {
	declare readonly _serviceBrand: undefined;
	isReady = false;
	private readonly _onDidBecomeReady = new Emitter<void>();
	onDidBecomeReady = this._onDidBecomeReady.event;
	stats = { totalFiles: 0, totalChunks: 0, lastIndexedAt: 0, isReady: false };

	async search(_query: string, _topK: number): Promise<CodeSnippet[]> { return []; }
	async reindex(): Promise<void> {}
	async indexFile(_fp: string): Promise<void> {}
	async removeFile(_fp: string): Promise<void> {}
}

// ── Context Service ───────────────────────────────────────────

export class MockAIContextService implements IAIContextService {
	declare readonly _serviceBrand: undefined;

	async buildContext(_input: BuildContextInput): Promise<AIMessage[]> {
		return [{ role: 'system', content: 'You are a test coding agent.' }];
	}

	getEditorContext(): { filePath: string; languageId: string; line: number; column: number; selection: string } {
		return { filePath: '/test.ts', languageId: 'typescript', line: 1, column: 1, selection: '' };
	}

	async searchRelevant(_query: string, _topK: number): Promise<CodeSnippet[]> { return []; }
}

// ── Log Service ───────────────────────────────────────────────

export class MockLogService implements ILogService {
	declare readonly _serviceBrand: undefined;
	info(..._args: any[]): void {}
	error(..._args: any[]): void {}
	warn(..._args: any[]): void {}
	trace(..._args: any[]): void {}
	debug(..._args: any[]): void {}
}

// ── Configuration Service ─────────────────────────────────────

export class MockConfigurationService implements Partial<IConfigurationService> {
	_serviceBrand: undefined;
	private _values: Record<string, unknown> = {};

	setValue(key: string, value: unknown): void { this._values[key] = value; }

	getValue<T>(key: string, defaultValue?: T): T | undefined {
		return (this._values[key] as T) ?? defaultValue;
	}

	onDidChangeConfiguration = new Emitter<any>().event;
	updateValue = async () => {};
}

// ── File Service ──────────────────────────────────────────────

export class MockFileService implements Partial<IFileService> {
	_serviceBrand: undefined;
	private _files = new Map<string, string>();

	setFile(path: string, content: string): void { this._files.set(path, content); }

	async readFile(uri: any): Promise<{ value: { toString(): string } }> {
		const path = uri.fsPath || uri.path || String(uri);
		return { value: { toString: () => this._files.get(path) || '' } };
	}

	async writeFile(_uri: any, _content: any): Promise<void> {}

	async resolve(_uri: any): Promise<{ children: Array<{ name: string; isDirectory: boolean }> }> {
		return { children: [] };
	}
}

// ── Diff Store ────────────────────────────────────────────────

export class MockDiffStore implements IDiffStore {
	declare readonly _serviceBrand: undefined;
	groups: any[] = [];
	onDidChange = new Emitter<void>().event;

	async initialize(_ws: string): Promise<void> {}
	addGroup(_g: any): void {}
	rejectHunk(_gid: string, _hid: string): void {}
	rejectAll(_gid: string): void {}
	getAppliedHunksForFile(_fp: string): any[] { return []; }
	getAllAppliedHunks(): any[] { return []; }
}

// ── Marker Service ────────────────────────────────────────────

export class MockMarkerService implements Partial<IMarkerService> {
	_serviceBrand: undefined;
	read = () => [] as any[];
}

// ── Workspace Context Service ─────────────────────────────────

export class MockWorkspaceContextService implements Partial<IWorkspaceContextService> {
	_serviceBrand: undefined;
	getWorkspace = () => ({ folders: [{ uri: { fsPath: '/tmp/test-workspace' } }] }) as any;
}

// ── Agent Deps Factory ────────────────────────────────────────

export interface AgentTestDeps {
	aiModelService: IAIModelService;
	indexService: IAIIndexService;
	contextService: IAIContextService;
	fileService: IFileService;
	logService: ILogService;
	configurationService: IConfigurationService;
	diffStore: IDiffStore;
	markerService: IMarkerService;
	workspaceContextService: IWorkspaceContextService;
}

export function createAgentDeps(overrides?: Partial<AgentTestDeps>): AgentTestDeps {
	const defaults: AgentTestDeps = {
		aiModelService: new MockAIModelService(),
		indexService: new MockAIIndexService(),
		contextService: new MockAIContextService(),
		fileService: new MockFileService() as unknown as IFileService,
		logService: new MockLogService(),
		configurationService: new MockConfigurationService() as unknown as IConfigurationService,
		diffStore: new MockDiffStore(),
		markerService: new MockMarkerService() as unknown as IMarkerService,
		workspaceContextService: new MockWorkspaceContextService() as unknown as IWorkspaceContextService,
	};
	return { ...defaults, ...overrides };
}
