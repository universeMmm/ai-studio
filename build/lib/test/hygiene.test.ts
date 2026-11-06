/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findUnexpectedUnicode, hasCopyrightHeader } from '../../hygiene.ts';
import { getVariableNameValidator } from '../stylelint/validateVariableNames.ts';

test('source hygiene accepts ASCII code and Chinese copy and comments', () => {
	for (const line of [
		'\tconst result = "ready"; // ordinary ASCII\r\n',
		'const message = "任务已完成，请检查文件。";',
		'// 「模型设置」支持中文（简体）；选择【保存】！',
	]) {
		assert.equal(findUnexpectedUnicode(line), null, line);
	}
});

test('source hygiene still identifies confusables, invisible controls, and damaged text', () => {
	for (const character of ['\u0430', '\u200b', '\u202e', '\ufffd']) {
		const line = 'const value = "' + character + '";';
		const match = findUnexpectedUnicode(line);
		assert.ok(match, `Expected a finding for U+${character.codePointAt(0)!.toString(16)}`);
		assert.equal(match[0], character);
		assert.equal(match.index, 15);
	}
});

const microsoftHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Microsoft Corporation. All rights reserved.',
	' *  Licensed under the MIT License. See License.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];
const studioHeader = [
	microsoftHeader[0],
	' *  Copyright (c) AI Studio contributors. All rights reserved.',
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.',
	microsoftHeader[3],
];

test('source hygiene accepts complete Microsoft and AI Studio MIT headers', () => {
	assert.equal(hasCopyrightHeader(microsoftHeader), true);
	assert.equal(hasCopyrightHeader(studioHeader), true);
	assert.equal(hasCopyrightHeader([...studioHeader, '', 'export const ready = true;']), true);
});

test('source hygiene rejects missing, incomplete, and invalid license headers', () => {
	assert.equal(hasCopyrightHeader([]), false);
	assert.equal(hasCopyrightHeader(['/* AI Studio feature */']), false);
	assert.equal(hasCopyrightHeader(microsoftHeader.slice(0, 3)), false);
	assert.equal(hasCopyrightHeader([studioHeader[0], studioHeader[1], studioHeader[3]]), false);
	assert.equal(hasCopyrightHeader([
		studioHeader[0], studioHeader[1], ' *  All rights reserved.', studioHeader[3],
	]), false);
	assert.equal(hasCopyrightHeader([
		studioHeader[0], ' *  Copyright (c) Unknown owner.', studioHeader[2], studioHeader[3],
	]), false);
});

test('CSS custom properties declared in the current stylesheet work with known theme tokens', () => {
	const validate = getVariableNameValidator(`
.studio-panel {
	--studio-line: var(--vscode-panel-border);
	--studio-accent: var(--vscode-textLink-foreground);
}
`);
	const unknown: string[] = [];
	validate('1px solid var(--studio-line, var(--vscode-editor-foreground))', name => unknown.push(name));
	validate('var(--studio-accent)', name => unknown.push(name));
	assert.deepEqual(unknown, []);
});

test('CSS custom property typos and unknown fallback variables are reported', () => {
	const validate = getVariableNameValidator('.studio-panel { --studio-line: transparent; }');
	const unknown: string[] = [];
	validate('var(--studio-lnie, var(--studio-unknown))', name => unknown.push(name));
	assert.deepEqual(unknown, ['--studio-lnie', '--studio-unknown']);
});

test('commented CSS declarations do not make a custom property valid', () => {
	const validate = getVariableNameValidator(`
/* .studio-panel {
	--studio-disabled: transparent;
} */
.studio-panel { /* --studio-commented: transparent; */ color: inherit; }
`);
	const unknown: string[] = [];
	validate('var(--studio-disabled) var(--studio-commented)', name => unknown.push(name));
	assert.deepEqual(unknown, ['--studio-disabled', '--studio-commented']);
});

test('CSS custom property declarations stay isolated between stylesheets', () => {
	const first = getVariableNameValidator('.first { --studio-only-first: transparent; }');
	const second = getVariableNameValidator('.second { --studio-only-second: transparent; }');
	const noStylesheet = getVariableNameValidator();
	const firstUnknown: string[] = [];
	const secondUnknown: string[] = [];
	const globalUnknown: string[] = [];
	first('var(--studio-only-first) var(--studio-only-second)', name => firstUnknown.push(name));
	second('var(--studio-only-first) var(--studio-only-second)', name => secondUnknown.push(name));
	noStylesheet('var(--studio-only-first)', name => globalUnknown.push(name));
	assert.deepEqual(firstUnknown, ['--studio-only-second']);
	assert.deepEqual(secondUnknown, ['--studio-only-first']);
	assert.deepEqual(globalUnknown, ['--studio-only-first']);
});
