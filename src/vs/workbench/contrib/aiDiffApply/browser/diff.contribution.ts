/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace change review commands and diff snapshots.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { basename, resolve } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { DiffDecorator } from './diffDecorator.js';
import { DiffStore, IDiffStore } from './diffStore.js';
import { DiffApplyController, IDiffApplyController } from './diffApplyController.js';

registerSingleton(IDiffStore, DiffStore, InstantiationType.Delayed);
registerSingleton(IDiffApplyController, DiffApplyController, InstantiationType.Delayed);

const snapshotScheme = 'ai-studio-change';

class AIDiffApplyContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiDiffApply';
	constructor(
		@IInstantiationService instantiation: IInstantiationService,
		@IDiffStore store: IDiffStore,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ITextModelService textModels: ITextModelService,
		@IModelService models: IModelService,
		@ILanguageService languages: ILanguageService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		this._register(instantiation.createInstance(DiffDecorator));
		const restore = () => {
			const folder = workspace.getWorkspace().folders[0];
			return store.initialize(folder?.uri.scheme === 'file' ? folder.uri.fsPath : '');
		};
		this._register(workspace.onDidChangeWorkspaceFolders(restore));
		this._register(lifecycle.onWillShutdown(event => event.join(store.whenSaved(), { id: 'aiStudio.review', label: '保存变更审查状态' })));
		void restore();
		this._register(textModels.registerTextModelContentProvider(snapshotScheme, {
			provideTextContent: async uri => {
				await restore();
				const query = new URLSearchParams(uri.query);
				const hunk = store.groups.find(g => g.id === query.get('group'))?.hunks.find(h => h.id === query.get('hunk'));
				if (!hunk) { return null; }
				const text = query.get('side') === 'before' ? hunk.originalText : hunk.modifiedText;
				return models.getModel(uri) ?? models.createModel(text, languages.createByFilepathOrFirstLine(URI.file(hunk.filePath)), uri);
			}
		}));
	}
}
registerWorkbenchContribution2(AIDiffApplyContribution.ID, AIDiffApplyContribution, WorkbenchPhase.BlockRestore);

CommandsRegistry.registerCommand('aiDiff.openPreview', async (a, groupId: string, hunkId: string) => {
	const hunk = a.get(IDiffStore).groups.find(g => g.id === groupId)?.hunks.find(h => h.id === hunkId);
	if (!hunk) { return; }
	const name = basename(hunk.filePath);
	const snapshot = (side: string) => URI.from({ scheme: snapshotScheme, path: '/' + name, query: new URLSearchParams({ group: groupId, hunk: hunkId, side }).toString() });
	await a.get(IEditorService).openEditor({
		original: { resource: snapshot('before') }, modified: { resource: snapshot('after') },
		label: name + ' · 变更对比', options: { pinned: true },
	});
});

CommandsRegistry.registerCommand('aiDiff.acceptHunk', (a, gid: string, hid: string) => a.get(IDiffApplyController).acceptHunk(gid, hid));

CommandsRegistry.registerCommand('aiDiff.rejectAll', async (a, gid?: string) => {
	const groups = a.get(IDiffStore).groups;
	const session = a.get(IChatWidgetService).lastFocusedWidget?.viewModel?.sessionResource.toString();
	const id = gid ?? groups.findLast(group => (!session || group.sessionId === session) && group.hunks.some(h => h.status === 'applied'))?.id;
	if (id) { await a.get(IDiffApplyController).rejectAll(id); }
});

CommandsRegistry.registerCommand('aiDiff.rejectHunk', async (a, gid?: string, hid?: string) => {
	const controller = a.get(IDiffApplyController);
	if (gid && hid) { return controller.rejectHunk(gid, hid); }
	const editor = getCodeEditor(a.get(IEditorService).activeTextEditorControl);
	const model = editor?.getModel();
	const position = editor?.getPosition();
	if (!model || !position) { return; }
	for (const group of [...a.get(IDiffStore).groups].reverse()) {
		const hunk = group.hunks.find(h => h.status === 'applied' && h.filePath === model.uri.fsPath &&
			h.modifiedStartLine <= position.lineNumber && h.modifiedEndLine >= position.lineNumber);
		if (hunk) { return controller.rejectHunk(group.id, hunk.id); }
	}
});

CommandsRegistry.registerCommand('aiDiff.jumpToNextFile', async a => {
	const editors = a.get(IEditorService);
	const store = a.get(IDiffStore);
	const files = [...new Set(store.getAllAppliedHunks().map(h => h.filePath))];
	if (!files.length) { return; }
	const current = editors.activeEditor?.resource?.fsPath ?? '';
	const next = files[(files.indexOf(current) + 1) % files.length];
	await editors.openEditor({ resource: URI.file(resolve(next)), options: { selection: { startLineNumber: store.getAppliedHunksForFile(next)[0].modifiedStartLine, startColumn: 1 } } });
});

// The toolbar opens review first so the user can see the file and change being acted on.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'aiDiff.reviewChangesFromToolbar', title: localize2('aiDiff.reviewChanges', '审查文件变更'), icon: Codicon.diff,
			menu: [{ id: MenuId.ChatMultiDiffContext, group: 'navigation', order: 1 }]
		});
	}
	override async run(a: ServicesAccessor): Promise<void> {
		await a.get(ICommandService).executeCommand('aiStudio.openInspector', 'changes');
	}
});

CommandsRegistry.registerCommand('aiDiff.rollbackChangesFromToolbar', a => a.get(ICommandService).executeCommand('aiDiff.rejectAll'));
KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.rejectAll', primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace, weight: 200 });
KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.rejectHunk', primary: KeyMod.Alt | KeyCode.KeyR, weight: 200 });
KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.jumpToNextFile', primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY, weight: 200 });
