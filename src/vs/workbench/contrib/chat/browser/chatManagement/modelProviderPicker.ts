/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ModelConfigurationPicker } from './modelConfigurationPicker.js';
import { BUILTIN_PROVIDERS, findProviderByKey, ProviderDefinition } from './providerDefinitions.js';

/** Provider branding and defaults on top of the shared configuration picker. */
export class ModelProviderPicker extends Disposable {
	readonly button: HTMLButtonElement;
	private readonly picker: ModelConfigurationPicker;

	constructor(
		parent: HTMLElement,
		id: string,
		provider: ProviderDefinition,
		onChange: (provider: ProviderDefinition) => void,
		onTab: (backwards: boolean) => void,
		@IActionWidgetService actions: IActionWidgetService,
	) {
		super();
		this.picker = this._register(new ModelConfigurationPicker(parent, id, {
			triggerClassName: 'model-configuration-provider-trigger',
			menuItemClassName: 'studio-provider-menu-item',
			menuClassName: 'model-configuration-provider-menu',
			menuLabel: localize('studio.provider.choose', '选择模型提供商'),
			onChange: id => {
				this.syncBranding();
				const selected = findProviderByKey(id);
				if (selected) { onChange(selected); }
			},
			onTab,
		}, actions));
		this.button = this.picker.button;
		this.picker.setOptions(BUILTIN_PROVIDERS.map(item => ({
			id: item.key,
			label: item.label,
			logo: item.logo,
			icon: item.logo ? ThemeIcon.fromId(`studio-provider-${item.logo.replace('.svg', '')}`) : Codicon.settingsGear,
			iconText: item.logo ? undefined : 'AI',
		})), provider.key);
		this.syncBranding();
	}

	get value(): string { return this.picker.value; }

	private syncBranding(): void {
		this.button.dataset.provider = this.value;
		// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
		this.button.querySelector('.model-configuration-picker-icon')?.classList.add('model-configuration-provider-trigger-icon');
		// eslint-disable-next-line no-restricted-syntax -- Integrate with an existing widget whose DOM nodes are not exposed as handles.
		this.button.querySelector('.model-configuration-picker-name')?.classList.add('model-configuration-provider-name');
	}

	close(restoreFocus = false): void {
		this.picker.close(restoreFocus);
	}
}
