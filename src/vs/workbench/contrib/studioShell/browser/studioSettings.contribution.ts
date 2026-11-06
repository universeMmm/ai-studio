/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStudioSettingsOptions, STUDIO_SETTINGS_EDITOR_ID, StudioSettingsEditor } from './studioSettingsEditor.js';
import { STUDIO_SETTINGS_INPUT_ID, StudioSettingsEditorInput } from './studioSettingsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StudioSettingsEditor, STUDIO_SETTINGS_EDITOR_ID, localize('studio.settings.editor', '设置')),
	[new SyncDescriptor(StudioSettingsEditorInput)],
);

class StudioSettingsSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean { return input instanceof StudioSettingsEditorInput; }
	serialize(): string { return ''; }
	deserialize(): StudioSettingsEditorInput { return StudioSettingsEditorInput.getOrCreate(); }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(STUDIO_SETTINGS_INPUT_ID, StudioSettingsSerializer);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'aiStudio.settings.open', title: localize2('studio.settings.open', 'AI Studio 设置'), f1: true });
	}
	async run(accessor: ServicesAccessor, section?: string): Promise<void> {
		const options: IStudioSettingsOptions = { pinned: true, section: typeof section === 'string' ? section : undefined };
		await accessor.get(IEditorService).openEditor(StudioSettingsEditorInput.getOrCreate(), options);
	}
});
