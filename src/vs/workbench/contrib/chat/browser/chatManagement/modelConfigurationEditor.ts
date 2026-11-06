/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modelConfigurationEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { clearNode, Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import { AI_STUDIO_VENDOR_ID } from '../../common/languageModels.js';
import { defaultGenerator } from '../../../../../base/common/idGenerator.js';
import { ModelConfigurationEditorInput } from './modelConfigurationEditorInput.js';
import { localize } from '../../../../../nls.js';
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
}

export const MODEL_CONFIGURATION_EDITOR_ID = 'workbench.editor.modelConfiguration';

export class ModelConfigurationEditor extends EditorPane {

	static readonly ID: string = MODEL_CONFIGURATION_EDITOR_ID;

	private dimension: Dimension | undefined;
	private container: HTMLElement | undefined;

	private listContainer: HTMLElement | undefined;
	private listItems: HTMLElement | undefined;
	private formContainer: HTMLElement | undefined;
	private nameInput: HTMLInputElement | undefined;

	private groups: readonly ILanguageModelsProviderGroup[] = [];
	private selectedGroup: ILanguageModelsProviderGroup | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAIKeychainService private readonly keychainService: IAIKeychainService,
	) {
		super(ModelConfigurationEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.model-configuration-editor'));

		// Left panel: model list
		this.listContainer = DOM.append(this.container, $('.model-configuration-list'));
		const listHeader = DOM.append(this.listContainer, $('.model-configuration-list-header'));
		DOM.append(listHeader, $('h3.model-configuration-list-title')).textContent = localize('modelConfigListTitle', "已配置模型");

		const addBtn = DOM.append(listHeader, $('button.model-configuration-add-btn'));
		addBtn.textContent = '+';
		addBtn.title = localize('addModel', "添加模型");
		addBtn.setAttribute('aria-label', addBtn.title);
		addBtn.onclick = () => this.onAddModel();

		this.renderModelList();

		// Right panel: config form
		this.formContainer = DOM.append(this.container, $('.model-configuration-form'));
		this.renderForm();
	}

	private renderModelList(): void {
		if (!this.listContainer) { return; }

		this.listItems?.remove();
		const listItems = this.listItems = DOM.append(this.listContainer, $('.model-configuration-list-items'));

		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);

		for (const group of this.groups) {
			const item = DOM.append(listItems, $('.model-configuration-list-item'));
			const select = DOM.append(item, $('button.model-configuration-select', { type: 'button' }));
			if (this.selectedGroup && this.selectedGroup.name === group.name) {
				item.classList.add('selected');
			}

			// Icon
			const icon = DOM.append(select, $('.model-configuration-list-item-icon', { 'aria-hidden': 'true' }));
			icon.textContent = 'AI';

			// Info (name + model)
			const info = DOM.append(select, $('.model-configuration-list-item-info'));
			const nameEl = DOM.append(info, $('span.model-configuration-list-item-name'));
			nameEl.textContent = group.name;

			const modelId = group.settings?.[group.name]?.['modelId'] as string | undefined;
			if (modelId) {
				const modelIdEl = DOM.append(info, $('span.model-configuration-list-item-model'));
				modelIdEl.textContent = modelId;
			}

			select.onclick = () => this.onSelectGroup(group);

			const deleteBtn = DOM.append(item, $('button.model-configuration-list-item-delete'));
			deleteBtn.textContent = '×';
			deleteBtn.title = localize('deleteModel', "删除模型");
			deleteBtn.setAttribute('aria-label', localize('studio.model.deleteNamed', '删除配置「{0}」', group.name));
			deleteBtn.onclick = (e) => {
				e.stopPropagation();
				this.onDeleteGroup(group);
			};
		}
	}

	private renderForm(): void {
		if (!this.formContainer) { return; }
		clearNode(this.formContainer);

		const group: ILanguageModelsProviderGroup = this.selectedGroup ?? { name: '', vendor: AI_STUDIO_VENDOR_ID };
		const settings = group.settings?.[group.name] ?? {};

		// —— Header ——
		const header = DOM.append(this.formContainer, $('.model-configuration-form-header'));
		const isNew = !group.name;
		DOM.append(header, $('h2.model-configuration-form-title')).textContent =
			isNew ? localize('newModel', "添加模型") : localize('editModel', "编辑模型");

		// —— Body ——
		const body = DOM.append(this.formContainer, $('.model-configuration-form-body'));

		// Section: 基本信息
		const basicSection = DOM.append(body, $('.model-configuration-form-section'));
		DOM.append(basicSection, $('.model-configuration-form-section-title')).textContent =
			localize('basicInfo', "基本信息");

		const nameInput = this.nameInput = this.createFormField(basicSection, localize('modelName', "配置名称"), 'text', group.name);
		nameInput.placeholder = localize('namePlaceholder', "例如：我的 DeepSeek");

		const modelIdInput = this.createFormField(basicSection, localize('modelId', "模型 ID"), 'text', (settings['modelId'] as string) ?? '');
		modelIdInput.placeholder = localize('modelIdPlaceholder', "例如：deepseek-chat");

		// Section: 连接配置
		const connSection = DOM.append(body, $('.model-configuration-form-section'));
		DOM.append(connSection, $('.model-configuration-form-section-title')).textContent =
			localize('connectionInfo', "连接配置");

		const apiKeyInput = this.createFormField(connSection, localize('studio.model.keyLabel', "API 密钥"), 'password', (settings['apiKey'] as string) ?? '');
		apiKeyInput.placeholder = isNew ? localize('studio.model.enterKey', '输入模型服务的密钥') : localize('studio.model.keepKey', '留空以保留当前密钥');

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
		const providerId = defaultGenerator.nextId();
		DOM.append(providerField, $('label', { for: providerId }, localize('provider', "模型提供商")));
		const providerSelect = DOM.append(providerField, $('select', { id: providerId })) as HTMLSelectElement;
		for (const p of BUILTIN_PROVIDERS) {
			const opt = DOM.append(providerSelect, $('option')) as HTMLOptionElement;
			opt.value = p.key;
			opt.textContent = p.label;
			if (p.key === currentProvider.key) {
				opt.selected = true;
			}
		}

		// Endpoint URL
		const endpointValue = storedEndpoint || currentProvider.baseUrl;
		const endpointInput = this.createFormField(connSection, localize('endpoint', "服务地址"), 'text', endpointValue);
		endpointInput.placeholder = 'https://api.example.com/v1';

		providerSelect.onchange = () => {
			const provider = findProviderByKey(providerSelect.value);
			if (provider) {
				if (provider.key !== 'custom') {
					endpointInput.value = provider.baseUrl;
				} else {
					endpointInput.value = '';
					endpointInput.focus();
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
			});
		};
	}

	private createFormField(parent: HTMLElement, label: string, type: string, value: string): HTMLInputElement {
		const field = DOM.append(parent, $('.model-configuration-form-field'));
		const id = defaultGenerator.nextId();
		DOM.append(field, $('label', { for: id }, label));
		const input = DOM.append(field, $<HTMLInputElement>('input', { id, type }));
		input.value = value;
		return input;
	}

	private async onSaveGroup(originalGroup: ILanguageModelsProviderGroup, data: ModelConfigFormData): Promise<void> {
		if (!data.name) {
			this.notificationService.warn(localize('nameRequired', "模型名称不能为空"));
			return;
		}

		if (!data.modelId) {
			this.notificationService.warn(localize('studio.model.idRequired', "请输入模型 ID。"));
			return;
		}
		if (originalGroup.name !== data.name && this.groups.some(group => group.name === data.name)) {
			this.notificationService.warn(localize('studio.model.nameExists', "已存在名为「{0}」的配置，请使用其他名称。", data.name));
			return;
		}

		const updatedGroup: ILanguageModelsProviderGroup = {
			vendor: AI_STUDIO_VENDOR_ID,
			name: data.name,
			settings: {
				[data.name]: {
					modelId: data.modelId,
					endpoint: data.endpoint,
					apiType: data.apiType,
				}
			}
		};

		try {
			if (!originalGroup.name) {
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
			if (data.apiKey) {
				await this.keychainService.setApiKey(data.apiKey);
			}
			await this.configurationService.updateValue('ai.apiType', data.apiType);
			await this.configurationService.updateValue('ai.apiBase', data.endpoint);
			await this.configurationService.updateValue('ai.modelId', data.modelId);
			await this.configurationService.updateValue('ai.modelName', data.name);
		} catch (err) {
			this.notificationService.error(localize('saveFailed', "无法保存模型配置。{0}", err instanceof Error ? err.message : String(err)));
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

		this.nameInput?.focus();
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
	}

	override async setInput(input: ModelConfigurationEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
		this.groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === AI_STUDIO_VENDOR_ID);
		this.selectedGroup = this.groups.find(group => group.name === this.configurationService.getValue<string>('ai.modelName')) ?? this.groups[0];
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
