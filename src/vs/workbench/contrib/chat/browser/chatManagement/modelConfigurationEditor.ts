/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modelConfigurationEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';
import { ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import { AI_STUDIO_VENDOR_ID } from '../../common/languageModels.js';
import { ModelConfigurationEditorInput } from './modelConfigurationEditorInput.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

const $ = DOM.$;

interface ModelConfigFormData {
	name: string;
	modelId: string;
	apiKey: string;
	endpoint: string;
}

export const MODEL_CONFIGURATION_EDITOR_ID = 'workbench.editor.modelConfiguration';

export class ModelConfigurationEditor extends EditorPane {

	static readonly ID: string = MODEL_CONFIGURATION_EDITOR_ID;

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private container: HTMLElement | undefined;

	private listContainer: HTMLElement | undefined;
	private formContainer: HTMLElement | undefined;

	private groups: readonly ILanguageModelsProviderGroup[] = [];
	private selectedGroup: ILanguageModelsProviderGroup | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(ModelConfigurationEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.container = DOM.append(parent, $('.model-configuration-editor'));

		// Left panel: model list
		this.listContainer = DOM.append(this.container, $('.model-configuration-list'));
		const listHeader = DOM.append(this.listContainer, $('.model-configuration-list-header'));
		DOM.append(listHeader, $('h3.model-configuration-list-title')).textContent = localize('modelConfigListTitle', "已配置模型");

		const addBtn = DOM.append(listHeader, $('button.model-configuration-add-btn'));
		addBtn.textContent = '+';
		addBtn.title = localize('addModel', "添加模型");
		addBtn.onclick = () => this.onAddModel();

		this.renderModelList();

		// Right panel: config form
		this.formContainer = DOM.append(this.container, $('.model-configuration-form'));
		this.renderForm();
	}

	private renderModelList(): void {
		if (!this.listContainer) { return; }

		// Remove existing list items (keep header)
		const existingList = this.listContainer.querySelector('.model-configuration-list-items');
		if (existingList) {
			existingList.remove();
		}

		const listItems = DOM.append(this.listContainer, $('.model-configuration-list-items'));

		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);

		if (this.groups.length === 0) {
			const emptyMsg = DOM.append(listItems, $('.model-configuration-list-empty'));
			emptyMsg.textContent = localize('noModelsConfigured', "暂无配置模型，点击 + 添加");
			return;
		}

		for (const group of this.groups) {
			const item = DOM.append(listItems, $('.model-configuration-list-item'));
			if (this.selectedGroup && this.selectedGroup.name === group.name) {
				item.classList.add('selected');
			}

			const nameEl = DOM.append(item, $('span.model-configuration-list-item-name'));
			nameEl.textContent = group.name;

			const modelId = group.settings?.[group.name]?.['modelId'] as string | undefined;
			if (modelId) {
				const modelIdEl = DOM.append(item, $('span.model-configuration-list-item-model'));
				modelIdEl.textContent = modelId;
			}

			item.onclick = () => this.onSelectGroup(group);

			const deleteBtn = DOM.append(item, $('button.model-configuration-list-item-delete'));
			deleteBtn.textContent = '×';
			deleteBtn.title = localize('deleteModel', "删除模型");
			deleteBtn.onclick = (e) => {
				e.stopPropagation();
				this.onDeleteGroup(group);
			};
		}
	}

	private renderForm(): void {
		if (!this.formContainer) { return; }
		this.formContainer.innerHTML = '';

		if (!this.selectedGroup) {
			const emptyState = DOM.append(this.formContainer, $('.model-configuration-form-empty'));
			DOM.append(emptyState, $('p')).textContent = localize('selectModelToEdit', "选择左侧模型进行编辑，或点击 + 添加新模型");
			return;
		}

		const group = this.selectedGroup;
		const settings = group.settings?.[group.name] ?? {};

		const formTitle = DOM.append(this.formContainer, $('h3.model-configuration-form-title'));
		formTitle.textContent = localize('editModel', "编辑模型: {0}", group.name);

		const form = DOM.append(this.formContainer, $('.model-configuration-form-fields'));

		// Name field
		const nameField = this.createFormField(form, localize('modelName', "配置名称"), 'text', group.name);
		const nameInput = nameField.querySelector('input') as HTMLInputElement;

		// Model ID field
		const modelIdField = this.createFormField(form, localize('modelId', "模型 ID"), 'text', (settings['modelId'] as string) ?? '');
		const modelIdInput = modelIdField.querySelector('input') as HTMLInputElement;

		// API Key field
		const apiKeyField = this.createFormField(form, localize('apiKey', "API Key"), 'password', (settings['apiKey'] as string) ?? '');
		const apiKeyInput = apiKeyField.querySelector('input') as HTMLInputElement;

		// Endpoint URL field
		const endpointField = this.createFormField(form, localize('endpoint', "端点 URL"), 'text', (settings['endpoint'] as string) ?? '');
		const endpointInput = endpointField.querySelector('input') as HTMLInputElement;

		// Save button
		const saveBtn = DOM.append(form, $('button.model-configuration-save-btn'));
		saveBtn.textContent = localize('save', "保存");
		saveBtn.onclick = async () => {
			await this.onSaveGroup(group, {
				name: nameInput.value.trim(),
				modelId: modelIdInput.value.trim(),
				apiKey: apiKeyInput.value.trim(),
				endpoint: endpointInput.value.trim(),
			});
		};
	}

	private createFormField(parent: HTMLElement, label: string, type: string, value: string): HTMLElement {
		const field = DOM.append(parent, $('.model-configuration-form-field'));
		const labelEl = DOM.append(field, $('label'));
		labelEl.textContent = label;
		const input = DOM.append(field, $('input'));
		input.setAttribute('type', type);
		input.setAttribute('value', value);
		if (type === 'password') {
			input.setAttribute('placeholder', 'sk-...');
		}
		return field;
	}

	private async onSaveGroup(originalGroup: ILanguageModelsProviderGroup, data: ModelConfigFormData): Promise<void> {
		if (!data.name) {
			this.notificationService.warn(localize('nameRequired', "模型名称不能为空"));
			return;
		}

		const updatedGroup: ILanguageModelsProviderGroup = {
			vendor: AI_STUDIO_VENDOR_ID,
			name: data.name,
			settings: {
				[data.name]: {
					modelId: data.modelId,
					apiKey: data.apiKey,
					endpoint: data.endpoint,
				}
			}
		};

		try {
			if (originalGroup.name !== data.name) {
				// Name changed - remove old and add new
				await this.languageModelsConfigurationService.removeLanguageModelsProviderGroup(originalGroup);
				await this.languageModelsConfigurationService.addLanguageModelsProviderGroup(updatedGroup);
			} else {
				await this.languageModelsConfigurationService.updateLanguageModelsProviderGroup(originalGroup, updatedGroup);
			}

			// Reload list
			this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
				.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);
			this.selectedGroup = this.groups.find(g => g.name === data.name);
			this.renderModelList();
			this.renderForm();

			// Refresh chat models
			this.commandService.executeCommand('workbench.action.chat.refreshModels');
		} catch (err) {
			this.notificationService.error(localize('saveFailed', "保存失败: {0}", String(err)));
		}
	}

	private onSelectGroup(group: ILanguageModelsProviderGroup): void {
		this.selectedGroup = group;
		this.renderModelList();
		this.renderForm();
	}

	private onAddModel(): void {
		const newGroup: ILanguageModelsProviderGroup = {
			vendor: AI_STUDIO_VENDOR_ID,
			name: '',
			settings: {}
		};
		this.selectedGroup = newGroup;
		this.renderModelList();
		this.renderForm();

		// Focus the name input
		const nameInput = this.formContainer?.querySelector('input[type="text"]') as HTMLInputElement;
		if (nameInput) {
			nameInput.focus();
		}
	}

	private async onDeleteGroup(group: ILanguageModelsProviderGroup): Promise<void> {
		await this.languageModelsConfigurationService.removeLanguageModelsProviderGroup(group);
		if (this.selectedGroup?.name === group.name) {
			this.selectedGroup = undefined;
		}
		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);
		this.renderModelList();
		this.renderForm();

		// Refresh chat models
		this.commandService.executeCommand('workbench.action.chat.refreshModels');
	}

	override async setInput(input: ModelConfigurationEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
		// Refresh data when opened
		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);
		this.selectedGroup = undefined;
		this.renderModelList();
		this.renderForm();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		super.focus();
	}

	override clearInput(): void {
		super.clearInput();
	}
}
