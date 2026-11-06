/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workspace commands
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { IAIIndexService } from '../../../../platform/ai/browser/aiIndexService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import './studioSessions.js';
import './media/aiChat.css';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'ai.chat.open', title: localize2('studio.open', "打开智能体工作区"), f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyL, weight: KeybindingWeight.WorkbenchContrib }
		});
	}
	run(accessor: ServicesAccessor) {
		const editors = accessor.get(IEditorService);
		const last = editors.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(item => item.editor instanceof ChatEditorInput);
		if (last) { return editors.openEditor(last.editor, { pinned: true }, last.groupId); }
		return editors.openEditor({ resource: ChatEditorInput.getNewEditorUri(), options: { pinned: true } });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'ai.chat.new', title: localize2('studio.new', "新建智能体会话"), f1: true });
	}
	run(accessor: ServicesAccessor) {
		return accessor.get(IEditorService).openEditor({ resource: ChatEditorInput.getNewEditorUri(), options: { pinned: true } });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'ai.reindex', title: localize2('studio.index', "重建工作区索引"), f1: true });
	}
	run(accessor: ServicesAccessor) { return accessor.get(IAIIndexService).reindex(); }
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'ai.settings', title: localize2('studio.settings', "配置智能体模型"), f1: true });
	}
	run(accessor: ServicesAccessor) {
		return accessor.get(ICommandService).executeCommand('chat.modelConfiguration.open');
	}
});
