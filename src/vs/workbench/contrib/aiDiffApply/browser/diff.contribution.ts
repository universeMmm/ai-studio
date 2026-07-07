/*---------------------------------------------------------------------------------------------
 *  AI Studio — Diff Contribution
 *  Commands, keybindings, and service registration for diff apply.
 *--------------------------------------------------------------------------------------------*/

import { IDiffStore, DiffStore } from './diffStore.js';
import { DiffDecorator } from './diffDecorator.js';
import { DiffApplyController } from './diffApplyController.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IActiveCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { URI } from '../../../../base/common/uri.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';

registerSingleton(IDiffStore, DiffStore, InstantiationType.Delayed);

class AIDiffApplyContribution implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiDiffApply';
	constructor(@IInstantiationService is: IInstantiationService) { is.createInstance(DiffDecorator); }
}
registerWorkbenchContribution2(AIDiffApplyContribution.ID, AIDiffApplyContribution, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand({ id: 'aiDiff.rejectAll', metadata: { description: 'AI Diff: Reject All' }, handler: async (a, gid?: string) => {
	const is = a.get(IInstantiationService); const c = is.createInstance(DiffApplyController);
	if (gid) { await c.rejectAll(gid); } else { const groups = a.get(IDiffStore).groups; if (groups.length) await c.rejectAll(groups[groups.length - 1].id); }
}});

CommandsRegistry.registerCommand({ id: 'aiDiff.rejectHunk', metadata: { description: 'AI Diff: Reject Hunk' }, handler: async (a) => {
	const es = a.get(IEditorService), ds = a.get(IDiffStore), is = a.get(IInstantiationService);
	const ed = es.activeTextEditorControl; if (!ed) return;
	const model = ed.getModel(), pos = ed.getPosition(); if (!model || !pos) return;
	for (const h of ds.getAppliedHunksForFile((model as any).uri.fsPath)) { if (pos.lineNumber >= h.modifiedStartLine && pos.lineNumber <= h.modifiedEndLine) { for (const g of ds.groups) { for (const gh of g.hunks) { if (gh.id === h.id) { await is.createInstance(DiffApplyController).rejectHunk(g.id, h.id); return; } } } } }
}});

CommandsRegistry.registerCommand({ id: 'aiDiff.jumpToNextFile', metadata: { description: 'AI Diff: Jump to Next File' }, handler: async (a) => {
	const es = a.get(IEditorService), ds = a.get(IDiffStore);
	const files = [...new Set(ds.getAllAppliedHunks().map(h => h.filePath))];
	if (!files.length) return;
	const cur = (es.activeTextEditorControl as IActiveCodeEditor | undefined)?.getModel()?.uri?.fsPath;
	let idx = cur ? files.indexOf(cur) : -1;
	idx = (idx + 1) % files.length;
	const hunks = ds.getAppliedHunksForFile(files[idx]);
	await es.openEditor({ resource: URI.file(files[idx]), options: { selection: hunks[0] ? { startLineNumber: hunks[0].modifiedStartLine, startColumn: 1, endLineNumber: hunks[0].modifiedStartLine, endColumn: 1 } : undefined } });
}});

// Rollback button in the chat input toolbar
class RollbackChangesAction extends Action2 {
	static readonly ID = 'aiDiff.rollbackChangesFromToolbar';

	constructor() {
		super({
			id: RollbackChangesAction.ID,
			title: localize2('aiDiff.rollbackChanges', "Rollback AI Changes"),
			icon: Codicon.discard,
			category: 'AI Studio',
			f1: false,
			menu: [
				{
					id: MenuId.ChatInput,
					group: 'navigation',
					order: 50,
				},
				{
					id: MenuId.ChatMultiDiffContext,
					group: 'navigation',
					order: 1,
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const diffStore = accessor.get(IDiffStore);
		const instantiationService = accessor.get(IInstantiationService);
		const groups = diffStore.groups;
		if (groups.length) {
			const controller = instantiationService.createInstance(DiffApplyController);
			await controller.rejectAll(groups[groups.length - 1].id);
		}
	}
}
registerAction2(RollbackChangesAction);

KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.rejectAll', primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace, weight: 200 });
KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.rejectHunk', primary: KeyMod.Alt | KeyCode.KeyR, weight: 200 });
KeybindingsRegistry.registerKeybindingRule({ id: 'aiDiff.jumpToNextFile', primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY, weight: 200 });
