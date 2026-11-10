/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Native session inspector. All sections use live workbench state.
 *--------------------------------------------------------------------------------------------*/

import { append, $, isHTMLElement } from '../../../../base/browser/dom.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { AgentSession, AgentStep, DiffGroup, DiffHunk, Task } from '../../../../platform/ai/common/aiTypes.js';
import { MemoryStore } from '../../../../platform/ai/common/memoryStore.js';
import { IAIAgentService } from '../../../../platform/ai/browser/aiAgentService.js';
import { IAIIndexService } from '../../../../platform/ai/browser/aiIndexService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDiffStore } from '../../aiDiffApply/browser/diffStore.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { studioToolLabel } from '../../aiChat/browser/studioToolLabels.js';
import './media/inspector.css';

export type InspectorTab = 'changes' | 'activity' | 'context';
const tabs: Record<InspectorTab, string> = { changes: '变更', activity: '执行记录', context: '上下文' };

export class AIContextView extends ViewPane {
	static readonly ID = 'ai-studio.context';
	private content?: InspectorContent;
	private tab: InspectorTab = 'changes';

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.content = this._register(this.instantiationService.createInstance(InspectorContent, parent));
		this.content.selectTab(this.tab);
	}
	selectTab(tab: InspectorTab): void { this.tab = tab; this.content?.selectTab(tab); }
	override focus(): void { super.focus(); this.content?.focus(); }
	override getOptimalWidth(): number { return 304; }
}

function icon(parent: HTMLElement, name: string): void {
	append(parent, $('span.codicon.codicon-' + name, { 'aria-hidden': 'true' }));
}

function empty(parent: HTMLElement, symbol: string, title: string, text: string): void {
	const box = append(parent, $('.studio-inspector-empty'));
	icon(box, symbol);
	append(box, $('h3', {}, title));
	append(box, $('p', {}, text));
}

class InspectorContent extends Disposable {
	private readonly root: HTMLElement;
	private readonly status: HTMLElement;
	private readonly metrics = new Map<InspectorTab, HTMLElement>();
	private readonly nav: HTMLElement;
	private readonly body: HTMLElement;
	private readonly tabButtons = new Map<InspectorTab, HTMLButtonElement>();
	private readonly focusableElements = new Map<string, HTMLElement>();
	private tab: InspectorTab = 'changes';
	private allChanges = false;
	private session?: string;
	private archive: AgentSession | null = null;
	private loadingHistory = false;
	private readonly selection = this._register(new MutableDisposable());
	private readonly renderedControls = this._register(new DisposableStore());
	private readonly refresh = this._register(new RunOnceScheduler(() => this.render(), 35));
	private readonly expanded = new Set<string>();
	private readonly busy = new Set<string>();

	constructor(
		parent: HTMLElement,
		@IDiffStore private readonly diffs: IDiffStore,
		@IAIAgentService private readonly agent: IAIAgentService,
		@IAIIndexService private readonly index: IAIIndexService,
		@IEditorService private readonly editors: IEditorService,
		@IChatWidgetService private readonly chats: IChatWidgetService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileService private readonly files: IFileService,
		@ILabelService private readonly labels: ILabelService,
		@ICommandService private readonly commands: ICommandService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.root = append(parent, $('.studio-inspector'));
		const overview = append(this.root, $('.studio-inspector-overview'));
		const heading = append(overview, $('.studio-inspector-overview-heading'));
		const projectName = this.workspace.getWorkspace().folders[0]?.name ?? '任务详情';
		append(heading, $('span.studio-inspector-eyebrow', { title: projectName }, projectName));
		this.status = append(heading, $('span.studio-inspector-status', { role: 'status' }));
		const close = this.action(heading, '收起任务详情', () => this.commands.executeCommand('workbench.action.toggleAuxiliaryBar'), 'close');
		close.classList.add('studio-inspector-close');
		close.replaceChildren();
		icon(close, 'close');
		append(overview, $('p.studio-inspector-description', {}, '跟进执行进度，审查每一次修改。'));
		const metrics = append(overview, $('.studio-inspector-metrics', { 'aria-label': '当前会话概览' }));
		for (const [tab, label, symbol] of [['changes', '变更', 'diff'], ['activity', '执行记录', 'history'], ['context', '来源', 'references']] as const) {
			const button = this.action(metrics, label, () => this.selectTab(tab), 'metric:' + tab);
			button.classList.add('studio-inspector-metric');
			button.replaceChildren();
			icon(button, symbol);
			append(button, $('span', {}, label));
			this.metrics.set(tab, append(button, $('strong', {}, '0')));
		}
		this.nav = append(this.root, $('.studio-inspector-tabs', { role: 'tablist', 'aria-label': '任务详情' }));
		this.body = append(this.root, $('.studio-inspector-body', { role: 'tabpanel', tabindex: '0' }));
		for (const tab of Object.keys(tabs) as InspectorTab[]) {
			const button = this.action(this.nav, tabs[tab], () => this.selectTab(tab), tab);
			this.tabButtons.set(tab, button);
			button.setAttribute('role', 'tab');
			button.onkeydown = e => {
				const keys = Object.keys(tabs) as InspectorTab[];
				let next = keys.indexOf(tab);
				if (e.key === 'ArrowRight') { next = (next + 1) % keys.length; }
				else if (e.key === 'ArrowLeft') { next = (next + keys.length - 1) % keys.length; }
				else if (e.key === 'Home') { next = 0; }
				else if (e.key === 'End') { next = keys.length - 1; }
				else { return; }
				e.preventDefault();
				this.selectTab(keys[next]);
				this.focus();
			};
		}
		this._register(this.diffs.onDidChange(() => this.refresh.schedule()));
		this._register(this.agent.onDidChangeStatus(() => this.refresh.schedule()));
		this._register(this.agent.onDidAddStep(() => this.refresh.schedule()));
		this._register(this.agent.onDidChangeTasks(() => this.refresh.schedule()));
		this._register(this.index.onDidChangeStats(() => this.refresh.schedule()));
		this._register(this.chats.onDidChangeFocusedSession(() => this.updateSession()));
		this._register(this.editors.onDidActiveEditorChange(() => this.watchEditor()));
		this.watchEditor();
		this.updateSession();
	}

	selectTab(tab: InspectorTab): void {
		this.tab = tab;
		for (const [key, button] of this.tabButtons) {
			const active = key === tab;
			button.setAttribute('aria-selected', String(active));
			button.tabIndex = active ? 0 : -1;
			this.metrics.get(key)?.parentElement?.setAttribute('aria-pressed', String(active));
		}
		this.body.setAttribute('aria-label', tabs[tab]);
		this.body.scrollTop = 0;
		this.render();
	}

	focus(): void {
		const tab = this.tabButtons.get(this.tab);
		// Basic mode presents these sections as overview rows, while advanced mode
		// retains the tab strip. Focus the currently visible control in either layout.
		if (tab?.offsetParent) { tab.focus(); }
		else { this.metrics.get(this.tab)?.parentElement?.focus(); }
	}

	private watchEditor(): void {
		const editor = getCodeEditor(this.editors.activeTextEditorControl);
		this.selection.value = editor?.onDidChangeCursorSelection(() => { if (this.tab === 'context') { this.refresh.schedule(); } });
		this.refresh.schedule();
	}

	private updateSession(): void {
		const session = this.chats.lastFocusedWidget?.viewModel?.sessionResource.toString();
		// Opening a diff or code editor must keep the task being reviewed selected.
		if (!session || this.session === session) { return; }
		this.session = session;
		this.archive = null;
		this.allChanges = false;
		this.expanded.clear();
		const folder = this.workspace.getWorkspace().folders[0];
		this.loadingHistory = !!(session && folder);
		if (session && folder) {
			void new MemoryStore(folder.uri.fsPath, this.files, this.log).loadLatestForChat(session).then(value => {
				if (this.session === session && !this._store.isDisposed) {
					this.archive = value;
					this.loadingHistory = false;
					this.refresh.schedule();
				}
			});
		}
		this.refresh.schedule();
	}

	private render(): void {
		this.renderOverview();
		const active = this.body.ownerDocument.activeElement;
		const focus = isHTMLElement(active) && this.body.contains(active) ? active.dataset.focus : undefined;
		const scroll = this.body.scrollTop;
		this.renderedControls.clear();
		this.focusableElements.clear();
		this.body.replaceChildren();
		if (this.tab === 'changes') { this.renderChanges(); }
		if (this.tab === 'activity') { this.renderActivity(); }
		if (this.tab === 'context') { this.renderContext(); }
		if (focus) {
			const next = this.focusableElements.get(focus);
			(next ?? this.body).focus({ preventScroll: true });
		}
		this.body.scrollTop = scroll;
	}

	private renderOverview(): void {
		const status = this.live ? this.agent.status : this.archive?.status;
		const labels = { idle: '就绪', running: '执行中', waiting_for_approval: '等待确认', stopped: '已停止', error: '执行出错' };
		this.status.textContent = this.loadingHistory ? '读取中' : status ? labels[status] : '就绪';
		this.status.dataset.state = status ?? 'idle';
		const groups = this.diffs.groups.filter(g => !this.session || this.allChanges || g.sessionId === this.session);
		const pending = groups.flatMap(g => g.hunks).filter(h => h.status === 'applied').length;
		const calls = this.steps.filter(step => step.type === 'tool_use');
		const paths = new Set(calls.filter(step => ['read_file', 'write_file', 'edit_file'].includes(step.toolName ?? '') && typeof step.toolInput?.path === 'string').map(step => step.toolInput!.path as string));
		for (const [tab, value] of [['changes', pending], ['activity', calls.length], ['context', paths.size]] as const) {
			const metric = this.metrics.get(tab)!;
			metric.textContent = String(value);
			const button = metric.parentElement!;
			button.setAttribute('aria-label', `${button.title}：${value}`);
		}
	}

	private action(parent: HTMLElement, label: string, run: () => void, key: string, glyph?: string): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button', { type: 'button', title: label, 'aria-label': label, 'data-focus': key }));
		if (glyph) { icon(button, glyph); } else { button.textContent = label; }
		button.onclick = run;
		if (!this.focusableElements.has(key)) { this.focusableElements.set(key, button); }
		return button;
	}

	private async perform(key: string, operation: () => Promise<unknown>): Promise<void> {
		if (this.busy.has(key)) { return; }
		this.busy.add(key);
		this.render();
		try { await operation(); }
		catch (error) { this.notifications.error(error instanceof Error ? error : String(error)); }
		finally {
			this.busy.delete(key);
			if (!this._store.isDisposed) { this.render(); }
		}
	}

	private section(text: string, detail?: string): HTMLElement {
		const head = append(this.body, $('.studio-inspector-heading'));
		append(head, $('h3', {}, text));
		if (detail) { append(head, $('span', {}, detail)); }
		return head;
	}

	private fileButton(parent: HTMLElement, uri: URI, line = 1): void {
		const name = this.labels.getUriBasenameLabel(uri);
		const button = this.action(parent, '打开 ' + name, () => void this.perform('open:' + uri, () =>
			this.editors.openEditor({ resource: uri, options: { selection: { startLineNumber: Math.max(1, line), startColumn: 1 }, pinned: true } })), 'file:' + uri + ':' + line);
		button.textContent = '';
		button.classList.add('studio-inspector-file');
		icon(button, 'file-code');
		const nameBlock = append(button, $('span.studio-inspector-name'));
		append(nameBlock, $('strong', {}, name));
		append(nameBlock, $('small', {}, this.labels.getUriLabel(uri, { relative: true })));
		icon(button, 'go-to-file');
	}

	private renderChanges(): void {
		const head = this.section('文件变更');
		const outsideSession = this.session && this.diffs.groups.some(g => g.sessionId !== this.session);
		if (outsideSession) {
			const scopeContainer = append(head, $('.studio-inspector-scope'));
			const scope = this.renderedControls.add(new SelectBox([{ text: '当前会话' }, { text: '工作区' }], this.allChanges ? 1 : 0, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: '变更范围' }));
			scope.render(scopeContainer);
			// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
			const button = scopeContainer.querySelector<HTMLElement>('.monaco-select-box')!;
			button.dataset.focus = 'scope';
			this.focusableElements.set('scope', button);
			this.renderedControls.add(scope.onDidSelect(event => {
				this.allChanges = event.index === 1;
				this.render();
				this.focusableElements.get('scope')?.focus({ preventScroll: true });
			}));
		}
		const groups = this.diffs.groups.filter(g => !this.session || this.allChanges || g.sessionId === this.session);
		const pending = groups.flatMap(g => g.hunks.filter(h => h.status === 'applied'));
		if (!groups.length) {
			empty(this.body, 'diff', '暂无文件变更', '助手编辑文件后，可以在这里查看对比、保留或撤销更改。');
			return;
		}
		append(this.body, $('p.studio-inspector-summary', {}, pending.length ? `${new Set(pending.map(h => h.filePath)).size} 个文件 · ${pending.length} 处待审查` : '所有变更均已审查'));
		for (const group of [...groups].reverse()) {
			for (const hunk of group.hunks) { this.change(group, hunk); }
		}
	}

	private change(group: DiffGroup, hunk: DiffHunk): void {
		const item = append(this.body, $('article.studio-inspector-change'));
		this.fileButton(item, URI.file(hunk.filePath), hunk.modifiedStartLine);
		const id = group.id + '/' + hunk.id;
		const row = append(item, $('.studio-inspector-change-meta'));
		append(row, $('span', {}, hunk.kind === 'create' ? '新增文件' : `第 ${hunk.modifiedStartLine} 行`));
		const preview = this.action(row, '查看对比', () => void this.perform('diff:' + id, () => this.commands.executeCommand('aiDiff.openPreview', group.id, hunk.id)), 'diff:' + id);
		preview.classList.add('studio-inspector-link');
		if (hunk.status !== 'applied') {
			append(row, $('span.studio-inspector-reviewed', {}, hunk.status === 'accepted' ? '已保留' : '已撤销'));
			return;
		}
		const fragment = append(item, $('.studio-inspector-fragment', { 'aria-label': '变更片段' }));
		if (hunk.originalText) { append(fragment, $('code.removed', {}, '− ' + this.sample(hunk.originalText, hunk.modifiedText))); }
		if (hunk.modifiedText) { append(fragment, $('code.added', {}, '+ ' + this.sample(hunk.modifiedText, hunk.originalText))); }
		const actions = append(item, $('.studio-inspector-actions'));
		for (const [label, command] of [['保留', 'aiDiff.acceptHunk'], ['撤销', 'aiDiff.rejectHunk']]) {
			const button = this.action(actions, label, () => void this.perform(id, () => this.commands.executeCommand(command, group.id, hunk.id)), command + id);
			button.disabled = this.busy.has(id);
		}
	}

	private sample(text: string, other: string): string {
		let start = 0;
		let line = 0;
		while (start < text.length && start < other.length && text[start] === other[start]) {
			if (text[start] === '\n') { line = start + 1; }
			start++;
		}
		const end = text.indexOf('\n', line);
		return text.slice(line, Math.min(end < 0 ? text.length : end, line + 180)) || '（空行）';
	}

	private get live(): boolean { return !!this.session && this.session === this.agent.sessionId; }
	private get steps(): readonly AgentStep[] { return this.live ? this.agent.steps : this.archive?.steps ?? []; }
	private get tasks(): readonly Task[] { return (this.live ? this.agent.tasks : this.archive?.taskSnapshot ?? []).filter(t => t.status !== 'deleted'); }

	private renderActivity(): void {
		const tasks = this.tasks;
		if (tasks.length) {
			this.section('执行计划', `${tasks.filter(t => t.status === 'completed').length}/${tasks.length}`);
			for (const task of tasks) {
				const row = append(this.body, $('.studio-inspector-task'));
				icon(row, task.status === 'completed' ? 'check' : task.status === 'in_progress' ? 'circle-filled' : 'circle-outline');
				append(row, $('span', {}, task.subject));
				append(row, $('small', {}, task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '进行中' : '待处理'));
			}
		}
		this.section('执行记录');
		const steps = this.steps;
		if (!steps.length) {
			empty(this.body, 'history', this.loadingHistory ? '正在读取记录' : '暂无执行记录', '发送任务后，这里会显示工具调用、运行结果和执行计划。');
			return;
		}
		const results = new Map(steps.filter(s => s.type === 'tool_result' && s.toolCallId).map(s => [s.toolCallId, s]));
		const calls = new Set(steps.filter(s => s.type === 'tool_use' && s.toolCallId).map(s => s.toolCallId));
		for (const step of steps) {
			if (step.type === 'tool_result' && calls.has(step.toolCallId)) { continue; }
			const result = step.type === 'tool_use' && step.toolCallId ? results.get(step.toolCallId) : undefined;
			const title = step.type === 'tool_use' ? studioToolLabel(step.toolName ?? '工具调用') :
				{ thought: '任务消息', plan: '计划', error: '执行出错', tool_result: '工具结果' }[step.type];
			const key = 'step:' + step.stepNumber;
			const details = append(this.body, $<HTMLDetailsElement>('details.studio-inspector-event'));
			details.open = this.expanded.has(key);
			details.ontoggle = () => {
				if (details.isConnected) {
					if (details.open) { this.expanded.add(key); } else { this.expanded.delete(key); }
				}
			};
			const summary = append(details, $('summary', { 'data-focus': key }));
			this.focusableElements.set(key, summary);
			icon(summary, step.type === 'error' || step.isError || result?.isError ? 'warning' : step.type === 'tool_use' ? 'tools' : step.type === 'plan' ? 'checklist' : 'comment');
			append(summary, $('span', {}, title));
			const runStatus = this.live && this.agent.status === 'waiting_for_approval' ? '等待确认' : this.live && this.agent.status === 'running' ? '执行中' : '未完成';
			const settled = result?.outcome ? { success: '完成', error: '失败', denied: '已拒绝', cancelled: '已取消' }[result.outcome] : result?.isError ? '失败' : '完成';
			const status = step.type === 'tool_use' && step.toolCallId ? (result ? settled : runStatus) : '';
			append(summary, $('small', {}, status || new Date(step.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
			if (step.toolInput) { append(details, $('pre', {}, JSON.stringify(step.toolInput, null, 2))); }
			const output = result?.content ?? (step.type === 'tool_use' ? '' : step.content);
			if (output) { append(details, $('pre', {}, output)); }
		}
	}

	private renderContext(): void {
		this.section('当前编辑器');
		const editor = getCodeEditor(this.editors.activeTextEditorControl);
		const model = editor?.getModel();
		if (model && model.uri.scheme === 'file') {
			const position = editor?.getPosition();
			this.fileButton(this.body, model.uri, position?.lineNumber);
			append(this.body, $('p.studio-inspector-summary', {}, `${model.getLanguageId()} · 第 ${position?.lineNumber ?? 1} 行，第 ${position?.column ?? 1} 列`));
		} else { append(this.body, $('p.studio-inspector-summary', {}, '未打开代码文件')); }

		this.section('会话文件');
		const root = this.workspace.getWorkspace().folders[0]?.uri;
		const touched = new Map<string, URI>();
		for (const step of this.steps) {
			const path = step.toolInput?.path;
			if (step.type !== 'tool_use' || typeof path !== 'string' || !['read_file', 'write_file', 'edit_file'].includes(step.toolName ?? '')) { continue; }
			const uri = isAbsolute(path) ? URI.file(path) : root && URI.joinPath(root, path);
			if (uri && this.workspace.isInsideWorkspace(uri)) { touched.set(uri.toString(), uri); }
		}
		for (const uri of touched.values()) { this.fileButton(this.body, uri); }
		if (!touched.size) { append(this.body, $('p.studio-inspector-summary', {}, '本轮尚未读取或编辑文件')); }

		const head = this.section('代码索引');
		const stats = this.index.stats;
		this.action(head, stats.enabled ? '关闭索引' : '开启索引', () => void this.perform('toggle-index', () => this.commands.executeCommand('ai.index.toggle')), 'toggle-index');
		const reindex = this.action(head, stats.state === 'cancelled' ? '继续索引' : '更新索引', () => void this.perform('reindex', () => this.index.reindex()), 'reindex', 'refresh');
		reindex.disabled = this.busy.has('reindex') || !root || !stats.enabled || stats.state === 'indexing';
		if (stats.state === 'indexing') { this.action(head, '取消索引', () => this.index.cancel(), 'cancel-index', 'close'); }
		const status = !root ? '请先打开工作区' : !stats.enabled ? '索引已关闭' : stats.state === 'indexing' ? `正在索引 ${stats.processed} / ${stats.total} 个文件` : stats.state === 'cancelled' ? '索引已暂停，点击继续索引可恢复' : stats.state === 'error' ? '索引更新失败，仍可使用关键词搜索；点击更新索引重试' : `${stats.totalFiles} 个文件 · ${stats.totalChunks} 个代码块`;
		append(this.body, $('p.studio-inspector-summary', {}, status + (stats.limited ? ' · 已达到文件数上限' : '') + (stats.memoryLimited ? ' · 已达到索引内存预算，可在设置中调整' : '')));
	}
}
