/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { Registry } from '../../../src/vs/platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../src/vs/platform/configuration/common/configurationRegistry.js';
import { getDefaultIgnoredSettings } from '../../../src/vs/platform/userDataSync/common/userDataSync.js';
import { getIgnoredSettings, merge } from '../../../src/vs/platform/userDataSync/common/settingsMerge.js';
import { TestConfigurationService } from '../../../src/vs/platform/configuration/test/common/testConfigurationService.js';

suite('Legacy credential settings sync', () => {
	test('hidden migration-only credentials remain excluded from sync and its opt-in list', () => {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const node = { properties: { 'test.hiddenCredential': { type: 'string', included: false, ignoreSync: true } } };
		const config = new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-test.hiddenCredential'] });
		registry.registerConfiguration(node);
		try {
			assert.equal(registry.getConfigurationProperties()['test.hiddenCredential'], undefined);
			assert.ok(getDefaultIgnoredSettings().includes('test.hiddenCredential'));
			const ignored = getIgnoredSettings(getDefaultIgnoredSettings(), config);
			assert.ok(ignored.includes('test.hiddenCredential'));
			const merged = merge('{"test.hiddenCredential":"synthetic-secret","editor.fontSize":16}', '{}', '{}', ignored, [], { insertSpaces: true, tabSize: 2, eol: '\n' });
			assert.ok(merged.remoteContent);
			assert.ok(!merged.remoteContent.includes('synthetic-secret'));
			assert.equal(JSON.parse(merged.remoteContent)['editor.fontSize'], 16);
		} finally { registry.deregisterConfigurations([node]); config.onDidChangeConfigurationEmitter.dispose(); }
	});
});
