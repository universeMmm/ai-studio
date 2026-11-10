/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modelConfigurationEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { clearNode, Dimension } from '../../../../../base/browser/dom.js';
import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
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
import { FileAccess } from '../../../../../base/common/network.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ModelConfigurationEditorInput } from './modelConfigurationEditorInput.js';
import { ModelProviderPicker } from './modelProviderPicker.js';
import { ModelConfigurationPicker, ModelConfigurationPickerItem } from './modelConfigurationPicker.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAIKeychainService } from '../../../../../platform/ai/browser/credentialService.js';
import { getAICredentialTarget } from '../../../../../platform/ai/common/aiSecurityConfiguration.js';
import { discoverModels } from '../../../../../platform/ai/common/modelDiscovery.js';
import { BUILTIN_PROVIDERS, findConfiguredProvider, findProviderByKey, ProviderDefinition } from './providerDefinitions.js';

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

	private dimension: Dimension | undefined;
	private container: HTMLElement | undefined;

	private listContainer: HTMLElement | undefined;
	private listItems: HTMLElement | undefined;
	private formContainer: HTMLElement | undefined;
	private nameInput: HTMLInputElement | undefined;

	private groups: readonly ILanguageModelsProviderGroup[] = [];
	private selectedGroup: ILanguageModelsProviderGroup | undefined;
	private modelListRequest: AbortController | undefined;
	private readonly providerPicker = this._register(new MutableDisposable<ModelProviderPicker>());
	private readonly modelIdPicker = this._register(new MutableDisposable<ModelConfigurationPicker>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAIKeychainService private readonly keychainService: IAIKeychainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
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
			this.renderProviderIcon(icon, findConfiguredProvider(group.settings?.[group.name] ?? {}));

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

	private renderProviderIcon(icon: HTMLElement, provider: ProviderDefinition | undefined): void {
		clearNode(icon);
		icon.classList.toggle('has-provider-logo', !!provider?.logo);
		icon.dataset.provider = provider?.key ?? 'custom';
		icon.title = provider?.label ?? localize('studio.model.customProvider', '自定义供应商');
		if (provider?.logo) {
			const logo = DOM.append(icon, $('span.model-configuration-provider-logo'));
			logo.style.maskImage = asCSSUrl(FileAccess.asBrowserUri(`vs/workbench/contrib/chat/browser/chatManagement/media/providerLogos/${provider.logo}`));
		} else {
			icon.textContent = 'AI';
		}
	}

	private renderForm(): void {
		this.cancelModelListRequest();
		this.providerPicker.clear();
		this.modelIdPicker.clear();
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
		const modelIdField = modelIdInput.parentElement!;
		// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
		const modelIdLabel = modelIdField.querySelector('label')!;
		const modelIdRow = DOM.append(modelIdField, $('.model-configuration-model-id-row'));
		modelIdRow.appendChild(modelIdInput);
		const modelIdPicker = this.modelIdPicker.value = this.instantiationService.createInstance(ModelConfigurationPicker,
			modelIdRow, defaultGenerator.nextId(), {
			triggerClassName: 'model-configuration-model-id-trigger',
			menuItemClassName: 'studio-model-id-menu-item',
			menuClassName: 'model-configuration-model-id-menu',
			menuLabel: localize('studio.models.choose', '选择模型 ID'),
			onChange: id => { modelIdInput.value = id; },
			onTab: backwards => (backwards ? nameInput : fetchModelsButton).focus(),
			filterThreshold: 8,
		});
		modelIdPicker.setHidden(true);
		const fetchModelsButton = DOM.append(modelIdRow, $<HTMLButtonElement>('button.model-configuration-fetch-models', { type: 'button' }, localize('studio.models.fetch', '获取模型列表')));
		const modelIdHelp = DOM.append(modelIdField, $('.model-configuration-model-id-help'));
		const modelListStatus = DOM.append(modelIdHelp, $('span.model-configuration-model-list-status', { id: defaultGenerator.nextId(), role: 'status', 'aria-live': 'polite' }));
		modelIdInput.setAttribute('aria-describedby', modelListStatus.id);
		modelIdPicker.button.setAttribute('aria-describedby', modelListStatus.id);
		const manualModelButton = DOM.append(modelIdHelp, $<HTMLButtonElement>('button.model-configuration-manual-model', { type: 'button', hidden: true }, localize('studio.models.manual', '手动输入')));
		const showManualModel = () => {
			modelIdInput.hidden = false;
			modelIdPicker.setHidden(true);
			manualModelButton.hidden = true;
			modelIdLabel.htmlFor = modelIdInput.id;
			fetchModelsButton.textContent = localize('studio.models.fetch', '获取模型列表');
		};
		const invalidateModelList = () => {
			this.cancelModelListRequest();
			showManualModel();
			modelListStatus.textContent = '';
			modelListStatus.classList.remove('error');
			modelIdRow.removeAttribute('aria-busy');
			fetchModelsButton.disabled = false;
			modelIdPicker.button.disabled = false;
		};
		manualModelButton.onclick = () => { invalidateModelList(); modelIdInput.focus(); };

		// Section: 连接配置
		const connSection = DOM.append(body, $('.model-configuration-form-section'));
		DOM.append(connSection, $('.model-configuration-form-section-title')).textContent =
			localize('connectionInfo', "连接配置");

		const apiKeyInput = this.createFormField(connSection, localize('studio.model.keyLabel', "API 密钥"), 'password', '');
		apiKeyInput.placeholder = isNew ? localize('studio.model.enterKey', '输入模型服务的密钥') : localize('studio.model.keepKey', '留空以保留当前密钥');
		if (settings['apiKey']) {
			DOM.append(connSection, $('p')).textContent = localize('studio.model.legacyKey', '旧版明文密钥已停止自动使用，请重新输入密钥后保存。');
		}

		// Provider selector
		const storedEndpoint = (settings['endpoint'] as string) ?? '';
		const storedApiType = (settings['apiType'] as string) ?? '';
		let currentProvider = findConfiguredProvider(settings);
		if (!currentProvider && storedEndpoint) {
			currentProvider = findProviderByKey('custom')!;
		}
		if (!currentProvider) {
			currentProvider = BUILTIN_PROVIDERS[0]; // default to OpenAI
		}

		const providerField = DOM.append(connSection, $('.model-configuration-form-field'));
		const providerId = defaultGenerator.nextId();
		DOM.append(providerField, $('label', { for: providerId }, localize('provider', "模型提供商")));
		const providerPicker = this.providerPicker.value = this.instantiationService.createInstance(ModelProviderPicker,
			providerField, providerId, currentProvider,
			provider => {
				if (provider.key !== 'custom') {
					endpointInput.value = provider.baseUrl;
				} else {
					endpointInput.value = '';
					endpointInput.focus();
				}
				apiTypeInput.value = provider.apiType;
				// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
				const selectedIcon = this.listItems?.querySelector<HTMLElement>('.model-configuration-list-item.selected .model-configuration-list-item-icon');
				if (selectedIcon) { this.renderProviderIcon(selectedIcon, provider); }
				onConnectionChanged();
			},
			backwards => (backwards ? apiKeyInput : endpointInput).focus(),
		);

		// Endpoint URL
		const endpointValue = storedEndpoint || currentProvider.baseUrl;
		const endpointInput = this.createFormField(connSection, localize('endpoint', "服务地址"), 'text', endpointValue);
		endpointInput.placeholder = 'https://api.example.com/v1';

		// API Type (hidden, derived from provider)
		const apiTypeInput = DOM.append(body, $('input')) as HTMLInputElement;
		apiTypeInput.type = 'hidden';
		apiTypeInput.value = storedApiType || currentProvider.apiType;
		const credentialTarget = () => {
			try {
				if (!endpointInput.value.trim()) { return undefined; }
				const target = getAICredentialTarget(apiTypeInput.value, endpointInput.value.trim());
				return `${target.provider}:${target.origin}`;
			} catch { return undefined; }
		};
		let enteredKeyTarget = credentialTarget();
		const onConnectionChanged = () => {
			const target = credentialTarget();
			const clearedKey = !!apiKeyInput.value && target !== enteredKeyTarget;
			if (clearedKey) { apiKeyInput.value = ''; }
			enteredKeyTarget = target;
			invalidateModelList();
			if (clearedKey) { modelListStatus.textContent = localize('studio.models.connectionChanged', '服务目标已更改，请输入对应服务的密钥。'); }
		};
		endpointInput.oninput = onConnectionChanged;
		apiKeyInput.oninput = () => { enteredKeyTarget = credentialTarget(); invalidateModelList(); };
		fetchModelsButton.onclick = async () => {
			this.cancelModelListRequest();
			modelIdPicker.close();
			modelIdPicker.button.disabled = true;
			const controller = this.modelListRequest = new AbortController();
			const isCurrent = () => this.modelListRequest === controller && !controller.signal.aborted && this.formContainer?.contains(body);
			const endpoint = endpointInput.value.trim();
			const apiType = apiTypeInput.value;
			const enteredKey = apiKeyInput.value.trim();
			fetchModelsButton.disabled = true;
			fetchModelsButton.textContent = localize('studio.models.fetching', '获取中…');
			modelIdRow.setAttribute('aria-busy', 'true');
			modelListStatus.classList.remove('error');
			modelListStatus.textContent = localize('studio.models.fetchingStatus', '正在获取可用模型…');
			try {
				// Fetch against the unsaved form. Only reuse a secret bound to this
				// provider/origin; discovery must not save or switch the active model.
				if (!endpoint) { throw new Error(localize('studio.models.endpointRequired', '请先填写服务地址。')); }
				const target = getAICredentialTarget(apiType, endpoint);
				const apiKey = enteredKey || await this.keychainService.getApiKey(target);
				if (!isCurrent()) { return; }
				const models = await discoverModels({ endpoint, apiType, apiKey, signal: controller.signal });
				if (!isCurrent()) { return; }
				if (!models.length) {
					showManualModel();
					modelListStatus.textContent = localize('studio.models.empty', '服务未返回可用模型，可以继续手动输入模型 ID。');
					return;
				}
				const currentId = modelIdInput.value.trim();
				const options: ModelConfigurationPickerItem[] = [];
				if (currentId && !models.some(model => model.id === currentId)) {
					options.push({ id: currentId, label: localize('studio.models.currentId', '{0}（当前值，未在列表中）', currentId) });
				}
				for (const model of models) {
					options.push({ id: model.id, label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id });
				}
				modelIdPicker.setOptions(options, currentId || models[0].id);
				modelIdInput.value = modelIdPicker.value;
				modelIdInput.hidden = true;
				modelIdPicker.setHidden(false);
				modelIdPicker.button.disabled = false;
				manualModelButton.hidden = false;
				modelIdLabel.htmlFor = modelIdPicker.button.id;
				modelListStatus.textContent = localize('studio.models.fetched', '已获取 {0} 个模型', models.length);
				modelIdPicker.button.focus();
			} catch (error) {
				if (!isCurrent()) { return; }
				showManualModel();
				modelListStatus.classList.add('error');
				modelListStatus.textContent = localize('studio.models.fetchFailed', '{0} 可继续手动输入模型 ID。', error instanceof Error ? error.message : localize('studio.models.fetchFailedUnknown', '无法获取模型列表。'));
			} finally {
				if (isCurrent()) {
					this.modelListRequest = undefined;
					fetchModelsButton.disabled = false;
					modelIdPicker.button.disabled = false;
					modelIdRow.removeAttribute('aria-busy');
					fetchModelsButton.textContent = modelIdPicker.button.hidden ? localize('studio.models.fetch', '获取模型列表') : localize('studio.models.refresh', '刷新列表');
				}
			}
		};

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
				providerKey: providerPicker.value,
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
					providerKey: data.providerKey,
					// Keep an explicit provider capability declaration when editing connection details.
					...(typeof originalGroup.settings?.[originalGroup.name]?.['vision'] === 'boolean' ? { vision: originalGroup.settings[originalGroup.name]['vision'] } : {}),
				}
			}
		};

		try {
			const hasLegacyKey = !!originalGroup.settings?.[originalGroup.name]?.['apiKey'];
			if (hasLegacyKey && !data.apiKey) {
				this.notificationService.warn(localize('studio.model.legacyKey', '旧版明文密钥已停止自动使用，请重新输入密钥后保存。'));
				return;
			}
			// Do not publish a model selection if storing its new credential fails.
			if (data.apiKey) {
				await this.keychainService.setApiKey(data.apiKey, getAICredentialTarget(data.apiType, data.endpoint), { requirePersisted: hasLegacyKey });
			}
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
			await this.configurationService.updateValue('ai.apiType', data.apiType, ConfigurationTarget.USER);
			await this.configurationService.updateValue('ai.apiBase', data.endpoint, ConfigurationTarget.USER);
			await this.configurationService.updateValue('ai.modelId', data.modelId, ConfigurationTarget.USER);
			await this.configurationService.updateValue('ai.modelName', data.name, ConfigurationTarget.USER);
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
		if (this.dimension?.width !== dimension.width || this.dimension?.height !== dimension.height) {
			this.providerPicker.value?.close();
			this.modelIdPicker.value?.close();
		}
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
		this.cancelModelListRequest();
		this.providerPicker.clear();
		this.modelIdPicker.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (!visible) {
			this.providerPicker.value?.close();
			this.modelIdPicker.value?.close();
		}
		super.setEditorVisible(visible);
	}

	private cancelModelListRequest(): void {
		this.modelListRequest?.abort();
		this.modelListRequest = undefined;
	}

	override dispose(): void {
		this.cancelModelListRequest();
		super.dispose();
	}
}
