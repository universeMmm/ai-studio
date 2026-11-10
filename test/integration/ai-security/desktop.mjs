/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchDesktop } from '../ai-index/desktop.mjs';

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ai-security-desktop-')));
const workspace = path.join(tmp, 'workspace'), profile = path.join(tmp, 'profile');
await fs.mkdir(workspace); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
	'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
	'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'ai.index.enabled': false,
	'ai.apiType': 'openai', 'ai.apiBase': 'https://fixture.invalid/v1', 'ai.apiKey': 'synthetic-legacy',
}));
const report = { generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, commit: process.env.GITHUB_SHA, checks: {}, pass: false };
let app;
try {
	app = await launchDesktop(workspace, profile, path.join(tmp, 'extensions'));
	const page = await app.firstWindow(); page.setDefaultTimeout(60000);
	await page.locator('.monaco-workbench').waitFor();
	report.checks = await page.evaluate(async () => {
		const base = location.href.split('/out/')[0] + '/out/';
		const [contributions, tools, configuration, credentials, registry, configRegistry, commands, models] = await Promise.all([
			'vs/workbench/common/contributions.js', 'vs/platform/ai/browser/toolExecutor.js',
			'vs/platform/configuration/common/configuration.js', 'vs/platform/ai/browser/credentialService.js',
			'vs/platform/registry/common/platform.js', 'vs/platform/configuration/common/configurationRegistry.js',
			'vs/platform/commands/common/commands.js', 'vs/workbench/contrib/chat/common/languageModelsConfiguration.js',
		].map(name => import(base + name)));
		const service = contributions.WorkbenchContributionsRegistry.INSTANCE.instantiationService;
		const f = window.securityFixture = service.invokeFunction(accessor => ({
			config: accessor.get(configuration.IConfigurationService), keys: accessor.get(credentials.IAIKeychainService),
			commands: accessor.get(commands.ICommandService), models: accessor.get(models.ILanguageModelsConfigurationService),
			createTool: () => service.createInstance(tools.ToolExecutor), target: configuration.ConfigurationTarget.USER_LOCAL,
		}));
		const require = (condition, message) => { if (!condition) { throw new Error(message); } };
		const properties = registry.Registry.as(configRegistry.Extensions.Configuration).getConfigurationProperties();
		require(!properties['ai.apiKey'], 'Legacy key must be absent from Settings UI/schema');
		require(properties['ai.commandSandbox'].default === 'required', 'Sandbox must default to required');
		// The shared desktop launcher explicitly selects in-memory secret storage.
		require(await f.keys.getApiKey() === undefined, 'Ephemeral storage must not adopt a plaintext key');
		require(f.config.inspect('ai.apiKey').userLocalValue === 'synthetic-legacy', 'Legacy recovery value must remain intact');
		let result = await f.createTool().executeCall('run_command', { command: 'pwd' });
		require(result.outcome === 'success', 'Sandbox IPC failed: ' + result.text);
		result = await f.createTool().executeCall('run_command', { command: 'git status' });
		require(result.outcome === 'denied', 'External command must require approval');
		await f.config.updateValue('ai.commandSandbox', 'off', f.target);
		await f.config.updateValue('ai.commandApproval', 'none', f.target);
		result = await f.createTool().executeCall('run_command', { command: 'echo fixture' });
		require(result.outcome === 'denied', 'Unsandboxed commands must always require approval');
		await f.config.updateValue('ai.commandSandbox', 'required', f.target);
		await f.config.updateValue('ai.commandApproval', 'unsafe', f.target);
		await f.models.addLanguageModelsProviderGroup({ vendor: 'ai-studio', name: 'Legacy fixture', settings: { 'Legacy fixture': { apiType: 'openai', endpoint: 'https://fixture.invalid/v1', modelId: 'fixture', apiKey: 'synthetic-model-legacy' } } });
		await f.commands.executeCommand('chat.modelConfiguration.open');
		return { hiddenLegacySetting: true, ephemeralMigrationPreservesRecovery: true, sandboxViaDesktopIpc: true, externalCommandApproval: true, unsandboxedApproval: true };
	});
	await page.locator('.model-configuration-select').filter({ hasText: 'Legacy fixture' }).click();
	assert.equal(await page.locator('.model-configuration-form input[type=password]').inputValue(), '');
	report.checks.legacyModelKeyNotPrefilled = true;
	await page.locator('.model-configuration-form input[type=password]').fill('synthetic-replacement');
	await page.locator('.model-configuration-save-btn').click();
	await page.getByText('Persistent secret storage is required to replace a legacy credential.', { exact: false }).first().waitFor();
	assert.equal(await page.evaluate(() => window.securityFixture.models.getLanguageModelsProviderGroups().find(group => group.name === 'Legacy fixture').settings['Legacy fixture'].apiKey), 'synthetic-model-legacy');
	report.checks.failedCredentialSavePreservesModel = true;
	await page.evaluate(async () => {
		const f = window.securityFixture;
		await f.keys.setApiKey('synthetic-secure-key');
		if (await f.keys.getApiKey() !== 'synthetic-secure-key') { throw new Error('SecretStorage round trip failed'); }
	});
	assert.ok(!(await fs.readFile(path.join(profile, 'User', 'settings.json'), 'utf8')).includes('synthetic-secure-key'));
	report.checks.newCredentialAbsentFromSettings = true;
	report.pass = true;
} catch (error) {
	report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
	await app?.close();
	await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	const output = new URL('../../../.build/ai-security/', import.meta.url);
	await fs.mkdir(output, { recursive: true });
	await fs.writeFile(new URL('desktop-report.json', output), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
}
