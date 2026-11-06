/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ContextView, ContextViewDOMPosition, IContextViewProvider } from '../../../../browser/ui/contextview/contextview.js';
import { ISelectData, SelectBox, SeparatorSelectOption, unthemedSelectBoxStyles } from '../../../../browser/ui/selectBox/selectBox.js';
import { toDisposable } from '../../../../common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('SelectBox application dropdown', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const container = document.createElement('div');
		container.style.cssText = 'position:fixed;top:40px;left:20px;width:240px;height:30px;';
		document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));
		const context = store.add(new ContextView(document.body, ContextViewDOMPosition.ABSOLUTE));
		const provider: IContextViewProvider = {
			showContextView: (delegate, parent) => {
				context.setContainer(parent ?? document.body, ContextViewDOMPosition.ABSOLUTE);
				context.show(delegate);
			},
			hideContextView: () => context.hide(),
			layout: () => context.layout(),
		};
		const picker = store.add(new SelectBox([{ text: 'Alpha' }, SeparatorSelectOption, { text: 'Disabled', isDisabled: true }, { text: 'Beta' }], 0, provider, unthemedSelectBoxStyles, { ariaLabel: 'Choice', useCustomDrawn: false }));
		picker.render(container);
		const button = container.querySelector<HTMLButtonElement>('button.monaco-select-box')!;
		const events: ISelectData[] = [];
		store.add(picker.onDidSelect(event => events.push(event)));
		return { container, context, provider, picker, button, events };
	}

	function key(element: HTMLElement, value: string, keyCode: number): void {
		element.dispatchEvent(new KeyboardEvent('keydown', { key: value, keyCode, bubbles: true, cancelable: true }));
	}

	test('uses an application button even when legacy native mode is requested', () => {
		const { container, button, picker, events } = setup();
		assert.ok(button);
		assert.strictEqual(container.querySelector('select'), null);
		assert.strictEqual(button.getAttribute('aria-haspopup'), 'listbox');
		assert.strictEqual(button.textContent, 'Alpha');
		picker.setOptions([{ text: 'New option', value: 'new-value' }], 0);
		assert.strictEqual(button.textContent, 'New option');
		assert.strictEqual(button.value, 'new-value');
		assert.deepStrictEqual(events, []);
	});

	test('F4 and keyboard navigation use the custom list, skip disabled rows and cancel preview', () => {
		const { context, picker, button, events } = setup();
		picker.setOptions([{ text: 'Alpha', value: 'alpha-id' }, SeparatorSelectOption, { text: 'Disabled', isDisabled: true }, { text: 'Beta', value: 'beta-id' }], 0);
		key(button, 'F4', 115);
		assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
		const list = context.getViewElement().querySelector<HTMLElement>('.monaco-list')!;
		assert.ok(list);
		key(list, 'ArrowDown', 40);
		assert.strictEqual(button.textContent, 'Beta');
		assert.strictEqual(button.value, 'beta-id');
		key(list, 'Escape', 27);
		assert.strictEqual(button.textContent, 'Alpha');
		assert.strictEqual(button.value, 'alpha-id');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(document.activeElement, button);
		assert.deepStrictEqual(events, []);
		key(button, 'Enter', 13);
		key(list, 'ArrowDown', 40);
		key(list, 'Enter', 13);
		assert.strictEqual(button.textContent, 'Beta');
		assert.strictEqual(button.value, 'beta-id');
		assert.deepStrictEqual(events, [{ index: 3, selected: 'Beta' }]);
	});

	test('disabled and empty controls cannot open a menu', () => {
		const { picker, button } = setup();
		picker.setEnabled(false);
		button.click();
		key(button, 'F4', 115);
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		picker.setEnabled(true);
		picker.setOptions([], 0);
		button.click();
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(button.textContent, '');
	});

	test('replacing a context view resets the old picker without closing the replacement on disposal', () => {
		const { picker, button, context, provider } = setup();
		button.click();
		const list = context.getViewElement().querySelector<HTMLElement>('.monaco-list')!;
		key(list, 'ArrowDown', 40);
		provider.showContextView({
			getAnchor: () => button,
			render: parent => { parent.textContent = 'Replacement'; return null; },
		});
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(button.textContent, 'Alpha');
		picker.dispose();
		assert.strictEqual(context.getViewElement().textContent, 'Replacement');
		assert.notStrictEqual(context.getViewElement().style.display, 'none');
	});
});
