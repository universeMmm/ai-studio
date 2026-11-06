/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const STUDIO_SETTINGS_INPUT_ID = 'workbench.input.studioSettings';

export class StudioSettingsEditorInput extends EditorInput {

	private static instance: StudioSettingsEditorInput | undefined;
	readonly resource = undefined;

	static getOrCreate(): StudioSettingsEditorInput {
		if (!this.instance || this.instance.isDisposed()) { this.instance = new StudioSettingsEditorInput(); }
		return this.instance;
	}

	override get typeId(): string { return STUDIO_SETTINGS_INPUT_ID; }
	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}
	override getName(): string { return localize('studio.settings.name', '设置'); }
	override getIcon() { return Codicon.settingsGear; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof StudioSettingsEditorInput;
	}
	override async resolve(): Promise<null> { return null; }
}
