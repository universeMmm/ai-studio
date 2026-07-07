/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modelConfigurationEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { clearNode, Dimension } from '../../../../../base/browser/dom.js';
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
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAIKeychainService } from '../../../../../platform/ai/browser/credentialService.js';
import { BUILTIN_PROVIDERS, findProviderByKey } from './providerDefinitions.js';

const $ = DOM.$;

interface ModelConfigFormData {
	name: string;
	modelId: string;
	apiKey: string;
	endpoint: string;
	apiType: string;
	providerKey: string;
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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAIKeychainService private readonly keychainService: IAIKeychainService,
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

		const existingList = this.listContainer.querySelector('.model-configuration-list-items');
		if (existingList) {
			existingList.remove();
		}

		const listItems = DOM.append(this.listContainer, $('.model-configuration-list-items'));

		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);

		if (this.groups.length === 0) {
			const emptyMsg = DOM.append(listItems, $('.model-configuration-list-empty'));
			DOM.append(emptyMsg, $('.model-configuration-list-empty-icon')).textContent = '🔌';
			DOM.append(emptyMsg, $('.model-configuration-list-empty-text')).textContent =
				localize('noModelsConfigured', "暂无配置模型，点击 + 添加");
			return;
		}

		for (const group of this.groups) {
			const item = DOM.append(listItems, $('.model-configuration-list-item'));
			if (this.selectedGroup && this.selectedGroup.name === group.name) {
				item.classList.add('selected');
			}

			// Icon
			const icon = DOM.append(item, $('.model-configuration-list-item-icon'));
			icon.textContent = 'AI';

			// Info (name + model)
			const info = DOM.append(item, $('.model-configuration-list-item-info'));
			const nameEl = DOM.append(info, $('span.model-configuration-list-item-name'));
			nameEl.textContent = group.name;

			const modelId = group.settings?.[group.name]?.['modelId'] as string | undefined;
			if (modelId) {
				const modelIdEl = DOM.append(info, $('span.model-configuration-list-item-model'));
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
		clearNode(this.formContainer);

		if (!this.selectedGroup) {
			const emptyState = DOM.append(this.formContainer, $('.model-configuration-form-empty'));
			DOM.append(emptyState, $('.model-configuration-form-empty-icon')).textContent = '⚙️';
			DOM.append(emptyState, $('.model-configuration-form-empty-text')).textContent =
				localize('selectModelToEdit', "选择模型进行编辑");
			DOM.append(emptyState, $('.model-configuration-form-empty-sub')).textContent =
				localize('orAddNew', "或点击 + 添加新模型");
			return;
		}

		const group = this.selectedGroup;
		const settings = group.settings?.[group.name] ?? {};

		// —— Header ——
		const header = DOM.append(this.formContainer, $('.model-configuration-form-header'));
		const isNew = !group.name;
		DOM.append(header, $('h2.model-configuration-form-title')).textContent =
			isNew ? localize('newModel', "添加模型") : localize('editModel', "编辑模型");
		const subtitleEl = DOM.append(header, $('p.model-configuration-form-subtitle'));
		subtitleEl.textContent = isNew
			? localize('fillToAdd', "填写以下信息以添加新的模型配置")
			: group.name;

		// —— Body ——
		const body = DOM.append(this.formContainer, $('.model-configuration-form-body'));

		// Section: 基本信息
		const basicSection = DOM.append(body, $('.model-configuration-form-section'));
		DOM.append(basicSection, $('.model-configuration-form-section-title')).textContent =
			localize('basicInfo', "基本信息");

		const nameField = this.createFormField(basicSection, localize('modelName', "配置名称"), 'text', group.name);
		const nameInput = nameField.querySelector('input') as HTMLInputElement;
		nameInput.placeholder = localize('namePlaceholder', "例如：我的 DeepSeek");

		const modelIdField = this.createFormField(basicSection, localize('modelId', "模型 ID"), 'text', (settings['modelId'] as string) ?? '');
		const modelIdInput = modelIdField.querySelector('input') as HTMLInputElement;
		modelIdInput.placeholder = localize('modelIdPlaceholder', "例如：deepseek-chat");

		// Section: 连接配置
		const connSection = DOM.append(body, $('.model-configuration-form-section'));
		DOM.append(connSection, $('.model-configuration-form-section-title')).textContent =
			localize('connectionInfo', "连接配置");

		const apiKeyField = this.createFormField(connSection, localize('apiKey', "API Key"), 'password', (settings['apiKey'] as string) ?? '');
		const apiKeyInput = apiKeyField.querySelector('input') as HTMLInputElement;
		apiKeyInput.placeholder = 'sk-...';

		// Provider selector
		const storedEndpoint = (settings['endpoint'] as string) ?? '';
		const storedApiType = (settings['apiType'] as string) ?? '';
		let currentProvider = BUILTIN_PROVIDERS.find(p =>
			p.key !== 'custom' && p.baseUrl === storedEndpoint && p.apiType === storedApiType
		);
		if (!currentProvider && storedEndpoint) {
			currentProvider = findProviderByKey('custom')!;
		}
		if (!currentProvider) {
			currentProvider = BUILTIN_PROVIDERS[0]; // default to OpenAI
		}

		const providerField = DOM.append(connSection, $('.model-configuration-form-field'));
		DOM.append(providerField, $('label')).textContent = localize('provider', "模型提供商");
		const providerSelect = DOM.append(providerField, $('select')) as HTMLSelectElement;
		for (const p of BUILTIN_PROVIDERS) {
			const opt = DOM.append(providerSelect, $('option')) as HTMLOptionElement;
			opt.value = p.key;
			opt.textContent = p.label;
			if (p.key === currentProvider.key) {
				opt.selected = true;
			}
		}

		// Provider description hint
		const providerHint = DOM.append(providerField, $('.model-configuration-field-hint'));
		providerHint.textContent = currentProvider.key !== 'custom'
			? `端点: ${currentProvider.baseUrl}  ·  API: ${currentProvider.apiType === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}`
			: '手动输入端点 URL';

		// Endpoint URL
		const endpointValue = storedEndpoint || currentProvider.baseUrl;
		const endpointField = this.createFormField(connSection, localize('endpoint', "端点 URL"), 'text', endpointValue);
		const endpointInput = endpointField.querySelector('input') as HTMLInputElement;
		endpointInput.placeholder = 'https://api.example.com/v1';

		providerSelect.onchange = () => {
			const provider = findProviderByKey(providerSelect.value);
			if (provider) {
				if (provider.key !== 'custom') {
					endpointInput.value = provider.baseUrl;
					providerHint.textContent = `端点: ${provider.baseUrl}  ·  API: ${provider.apiType === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}`;
				} else {
					endpointInput.value = '';
					endpointInput.focus();
					providerHint.textContent = '手动输入端点 URL';
				}
				apiTypeInput.value = provider.apiType;
			}
		};

		// API Type (hidden, derived from provider)
		const apiTypeInput = DOM.append(body, $('input')) as HTMLInputElement;
		apiTypeInput.type = 'hidden';
		apiTypeInput.value = storedApiType || currentProvider.apiType;

		// —— Actions ——
		const actions = DOM.append(body, $('.model-configuration-form-actions'));
		const saveBtn = DOM.append(actions, $('button.model-configuration-save-btn'));
		saveBtn.textContent = isNew
			? localize('addModelBtn', "添加模型")
			: localize('save', "保存配置");
		saveBtn.onclick = async () => {
			await this.onSaveGroup(group, {
				name: nameInput.value.trim(),
				modelId: modelIdInput.value.trim(),
				apiKey: apiKeyInput.value.trim(),
				endpoint: endpointInput.value.trim(),
				apiType: apiTypeInput.value,
				providerKey: providerSelect.value,
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
					apiType: data.apiType,
				}
			}
		};

		try {
			if (originalGroup.name !== data.name) {
				await this.languageModelsConfigurationService.removeLanguageModelsProviderGroup(originalGroup);
				await this.languageModelsConfigurationService.addLanguageModelsProviderGroup(updatedGroup);
			} else {
				await this.languageModelsConfigurationService.updateLanguageModelsProviderGroup(originalGroup, updatedGroup);
			}

			this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
				.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);
			this.selectedGroup = this.groups.find(g => g.name === data.name);
			this.renderModelList();
			this.renderForm();

			// Sync to ai.* settings so the chat agent host can use this model
			this.configurationService.updateValue('ai.modelId', data.modelId);
			this.configurationService.updateValue('ai.modelName', data.name);
			this.configurationService.updateValue('ai.apiType', data.apiType);
			if (data.apiKey) {
				this.configurationService.updateValue('ai.apiKey', data.apiKey);
				this.keychainService.setApiKey(data.apiKey);
			}
			if (data.endpoint) {
				this.configurationService.updateValue('ai.apiBase', data.endpoint);
			}

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

		this.commandService.executeCommand('workbench.action.chat.refreshModels');
	}

	override async setInput(input: ModelConfigurationEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
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
