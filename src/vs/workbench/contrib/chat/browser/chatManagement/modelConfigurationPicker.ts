/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { AnchorPosition } from '../../../../../base/common/layout.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';

export interface ModelConfigurationPickerItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: ThemeIcon;
	/** Local SVG filename in media/providerLogos. */
	readonly logo?: string;
	/** Text fallback for the trigger icon. */
	readonly iconText?: string;
}

export interface ModelConfigurationPickerOptions {
	readonly triggerClassName: string;
	readonly menuItemClassName: string;
	readonly menuClassName: string;
	readonly menuLabel: string;
	readonly onChange: (id: string) => void;
	readonly onTab: (backwards: boolean) => void;
	readonly filterThreshold?: number;
}

interface PickerAction {
	readonly id: string;
	readonly checked: boolean;
}

/** Shared form picker backed by the workbench's keyboard-accessible, scrollable action list. */
export class ModelConfigurationPicker extends Disposable {
	readonly button: HTMLButtonElement;
	private readonly menuListeners = this._register(new DisposableStore());
	private items: readonly ModelConfigurationPickerItem[] = [];
	private selectedId = '';
	private open = false;
	private restoreFocus = false;

	constructor(
		parent: HTMLElement,
		id: string,
		private readonly options: ModelConfigurationPickerOptions,
		@IActionWidgetService private readonly actions: IActionWidgetService,
	) {
		super();
		this.button = DOM.append(parent, DOM.$<HTMLButtonElement>('button.model-configuration-picker-trigger', {
			id, type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
		}));
		this.button.classList.add(options.triggerClassName);
		this.render();
		this._register(DOM.addDisposableListener(this.button, 'click', () => this.open ? this.close(true) : this.show()));
		this._register(DOM.addDisposableListener(this.button, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				event.stopPropagation();
				this.show();
			}
		}));
	}

	get value(): string { return this.selectedId; }

	setOptions(items: readonly ModelConfigurationPickerItem[], selectedId: string): void {
		this.close();
		this.items = [...items];
		this.selectedId = items.some(item => item.id === selectedId) ? selectedId : items[0]?.id ?? '';
		this.render();
	}

	setHidden(hidden: boolean): void {
		if (hidden) { this.close(); }
		this.button.hidden = hidden;
	}

	private render(): void {
		DOM.clearNode(this.button);
		this.button.disabled = !this.items.length;
		const selected = this.items.find(item => item.id === this.selectedId);
		if (selected && (selected.logo || selected.iconText || selected.icon)) {
			const icon = DOM.append(this.button, DOM.$('span.model-configuration-picker-icon', { 'aria-hidden': 'true' }));
			if (selected.logo) {
				const logo = DOM.append(icon, DOM.$('span.model-configuration-picker-logo.model-configuration-provider-logo'));
				logo.style.maskImage = asCSSUrl(FileAccess.asBrowserUri(`vs/workbench/contrib/chat/browser/chatManagement/media/providerLogos/${selected.logo}`));
			} else if (selected.iconText) {
				icon.textContent = selected.iconText;
			} else if (selected.icon) {
				DOM.append(icon, renderIcon(selected.icon));
			}
		}
		DOM.append(this.button, DOM.$('span.model-configuration-picker-name', {}, selected?.label ?? this.options.menuLabel));
		DOM.append(this.button, renderIcon(Codicon.chevronDown));
	}

	private show(): void {
		if (this.open || !this.items.length || this.button.hidden || !this.button.isConnected) { return; }
		const items: IActionListItem<PickerAction>[] = this.items.map(item => {
			const icon = item.icon ?? (item.logo ? ThemeIcon.fromId(`studio-provider-${item.logo.replace('.svg', '')}`) : undefined);
			return {
				kind: ActionListItemKind.Action,
				item: { id: item.id, checked: item.id === this.selectedId },
				label: item.label,
				description: item.id === this.selectedId ? '✓' : '',
				group: icon ? { title: '', icon } : undefined,
				hideIcon: !icon,
				className: this.options.menuItemClassName,
			};
		});
		const showFilter = this.options.filterThreshold !== undefined && items.length >= this.options.filterThreshold;
		const targetWindow = DOM.getWindow(this.button);
		const rect = this.button.getBoundingClientRect();
		const below = targetWindow.innerHeight - rect.bottom;
		const above = rect.top > below && below < items.length * 36 + 14 + (showFilter ? 36 : 0);
		const width = Math.max(100, Math.min(rect.width, targetWindow.innerWidth - 24) - 14);
		this.open = true;
		this.restoreFocus = false;
		this.button.setAttribute('aria-expanded', 'true');
		this.actions.show('StudioModelConfigurationPicker', false, items, {
			onSelect: item => {
				this.close(true);
				if (item.id !== this.selectedId) {
					this.selectedId = item.id;
					this.render();
					this.options.onChange(item.id);
				}
			},
			onHide: () => {
				if (!this.open) { return; }
				this.open = false;
				this.menuListeners.clear();
				this.button.setAttribute('aria-expanded', 'false');
				if (this.restoreFocus && this.button.isConnected) { this.button.focus(); }
			},
		}, this.button, undefined, [], {
			getWidgetAriaLabel: () => this.options.menuLabel,
			getWidgetRole: () => 'menu',
			getRole: () => 'menuitemradio',
			getAriaLabel: item => item.label ?? '',
			isChecked: item => !!item.item?.checked,
		}, {
			anchorPosition: above ? AnchorPosition.ABOVE : AnchorPosition.BELOW,
			minWidth: width, maxWidth: width, actionItemHeight: 36,
			reserveSubmenuSpace: false, hideDefaultKeybindingTooltip: true,
			showFilter, focusFilterOnOpen: showFilter,
			filterPlaceholder: localize('studio.modelPicker.filter', '选择模型'),
		});
		// Keep the popup's styling when filtering removes every rendered option.
		// show() has already focused the list or its filter input at this point.
		targetWindow.document.activeElement?.closest('.action-widget')?.classList.add('model-configuration-picker-menu', this.options.menuClassName);
		// Keep tab order in the form even though ContextView renders outside it.
		this.menuListeners.add(DOM.addDisposableListener(targetWindow, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Tab' || event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close(event.key === 'Escape');
				if (event.key === 'Tab') { this.options.onTab(event.shiftKey); }
			}
		}, true));
		this.menuListeners.add(DOM.addDisposableListener(targetWindow, 'resize', () => this.close()));
		const editor = this.button.closest('.model-configuration-editor');
		if (editor) {
			this.menuListeners.add(DOM.addDisposableListener(editor, 'scroll', () => {
				// Ignore a queued scroll from focusing the button if its anchor has not moved.
				const current = this.button.getBoundingClientRect();
				if (Math.abs(current.top - rect.top) > 0.5 || Math.abs(current.left - rect.left) > 0.5) { this.close(); }
			}, true));
		}
	}

	close(restoreFocus = false): void {
		if (this.open) {
			this.restoreFocus = restoreFocus;
			this.actions.hide();
		}
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}
}
