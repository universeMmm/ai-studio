/*---------------------------------------------------------------------------------------------
 *  AI Studio - AI Context Sidebar View
 *  Four-section panel showing Agent's current knowledge state.
 *  Registered via ViewsRegistry into the explorer container.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { IAIAgentService } from "../../../../platform/ai/browser/aiAgentService.js";
import { IAIContextService } from "../../../../platform/ai/browser/aiContextService.js";
import { IAIIndexService } from "../../../../platform/ai/browser/aiIndexService.js";

const HTML_TEMPLATE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); margin: 0; }
.section { margin-bottom: 12px; }
.section-title { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.section-title .codicon { font-size: 14px; }
.stat-row { display: flex; justify-content: space-between; padding: 2px 0; }
.stat-label { color: var(--vscode-descriptionForeground); }
.stat-value { font-weight: 500; }
.status-dot { width: 8px; height: 8px; border-radius: 50%%; display: inline-block; margin-right: 4px; }
.status-ready { background: var(--vscode-testing-iconPassed); }
.status-offline { background: var(--vscode-errorForeground); }
.file-item { padding: 1px 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-score { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: 4px; }
</style></head><body>
<div id="editor-section" class="section"></div>
<div id="index-section" class="section"></div>
<div id="memory-section" class="section"></div>
<div id="search-section" class="section"></div>
</body></html>`;

export class AIContextView extends Disposable {
	private _view: any = null;
	private _refreshTimer: any = null;

	constructor(
		@IAIAgentService private readonly agentService: IAIAgentService,
		@IAIContextService private readonly contextService: IAIContextService,
		@IAIIndexService private readonly indexService: IAIIndexService,
	) { super(); }

	resolveWebviewView(view: any, _ctx: unknown): void {
		this._view = view;
		view.webview.options = { enableScripts: false };
		view.webview.html = HTML_TEMPLATE;
		this._refresh();

		// Refresh every 2 seconds while visible
		this._refreshTimer = setInterval(() => this._refresh(), 2000);
		view.onDidChangeVisibility(() => {
			if (view.visible) { this._refresh(); }
		});
		view.onDidDispose(() => { clearInterval(this._refreshTimer); });
	}

	private _refresh(): void {
		if (!this._view?.visible) return;
		const editor = this.contextService.getEditorContext();
		const stats = this.indexService.stats;
		const memory = this.agentService?.memory;
		const plan = this.agentService?.plan;

		let html = "";

		// 1. Editor section
		html += '<div class="section-title"><span class="codicon codicon-file-code"></span>Current Editor</div>';
		if (editor.filePath) {
			html += '<div class="stat-row"><span class="stat-label">File</span><span class="stat-value">' + _esc(editor.filePath.split("/").pop() || editor.filePath) + '</span></div>';
			html += '<div class="stat-row"><span class="stat-label">Language</span><span class="stat-value">' + _esc(editor.languageId) + '</span></div>';
			html += '<div class="stat-row"><span class="stat-label">Cursor</span><span class="stat-value">L' + editor.line + ', C' + editor.column + '</span></div>';
		} else {
			html += '<div class="stat-row"><span class="stat-value">No editor open</span></div>';
		}

		// 2. Index section
		const indexReady = stats.isReady;
		html += '<div class="section-title"><span class="codicon codicon-database"></span>Code Index</div>';
		html += '<div class="stat-row"><span class="stat-label">Status</span><span class="stat-value"><span class="status-dot ' + (indexReady ? 'status-ready' : 'status-offline') + '"></span>' + (indexReady ? 'Ready' : 'Offline') + '</span></div>';
		html += '<div class="stat-row"><span class="stat-label">Files</span><span class="stat-value">' + (stats.totalFiles || 0) + '</span></div>';
		html += '<div class="stat-row"><span class="stat-label">Chunks</span><span class="stat-value">' + (stats.totalChunks || 0) + '</span></div>';

		// 3. Memory section
		html += '<div class="section-title"><span class="codicon codicon-comment-discussion"></span>Conversation</div>';
		if (memory) {
			html += '<div class="stat-row"><span class="stat-label">Messages</span><span class="stat-value">' + memory.messageCount + '</span></div>';
			html += '<div class="stat-row"><span class="stat-label">Est. Tokens</span><span class="stat-value">~' + memory.estimatedTokens + '</span></div>';
		}
		if (plan) {
			html += '<div class="stat-row"><span class="stat-label">Plan Steps</span><span class="stat-value">' + plan.steps.filter(s => s.status === "completed").length + '/' + plan.steps.length + ' done</span></div>';
		}

		// 4. Search section (placeholder for recent hits)
		html += '<div class="section-title"><span class="codicon codicon-search"></span>Recent Context</div>';
		html += '<div class="file-item">(last search results appear here)</div>';

		this._view.webview.postMessage({ html });
		// Fallback: direct HTML update if postMessage not supported
		this._view.webview.html = HTML_TEMPLATE.replace("</body>", html + "</body>");
	}
}

function _esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
