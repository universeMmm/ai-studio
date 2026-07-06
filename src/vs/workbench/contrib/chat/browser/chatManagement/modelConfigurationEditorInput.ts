/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { EditorInputCapabilities, GroupIdentifier, ISaveOptions, IUntypedEditorInput, SaveReason } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const MODEL_CONFIGURATION_EDITOR_INPUT_ID = 'workbench.input.modelConfiguration';

/**
 * Editor input for the Model Configuration Editor.
 * Singleton-style input with no file resource.
 */
export class ModelConfigurationEditorInput extends EditorInput {

	static readonly ID: string = MODEL_CONFIGURATION_EDITOR_INPUT_ID;

	readonly resource = undefined;

	private _isDirty = false;
	private _saveHandler?: () => Promise<boolean>;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}

	private static _instance: ModelConfigurationEditorInput | undefined;

	static getOrCreate(): ModelConfigurationEditorInput {
		if (!ModelConfigurationEditorInput._instance || ModelConfigurationEditorInput._instance.isDisposed()) {
			ModelConfigurationEditorInput._instance = new ModelConfigurationEditorInput();
		}
		return ModelConfigurationEditorInput._instance;
	}

	constructor() {
		super();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof ModelConfigurationEditorInput;
	}

	override get typeId(): string {
		return ModelConfigurationEditorInput.ID;
	}

	override getName(): string {
		return localize('modelConfigurationEditorName', "模型配置");
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override isDirty(): boolean {
		return this._isDirty;
	}

	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
		if (options?.reason !== undefined && options.reason !== SaveReason.EXPLICIT) {
			return undefined;
		}
		if (this._saveHandler) {
			const saved = await this._saveHandler();
			return saved ? this : undefined;
		}
		return undefined;
	}

	override async revert(): Promise<void> {
		this.setDirty(false);
	}

	setDirty(dirty: boolean): void {
		if (this._isDirty !== dirty) {
			this._isDirty = dirty;
			this._onDidChangeDirty.fire();
		}
	}

	setSaveHandler(handler: (() => Promise<boolean>) | undefined): void {
		this._saveHandler = handler;
	}
}
