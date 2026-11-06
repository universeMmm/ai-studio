/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-capabilities-'));
const profile = path.join(tmp, 'profile'), workspace = path.join(tmp, 'workspace');
const report = { checks: {}, methods: [], calls: [], proxyConnections: 0, errors: [] };
const sockets = new Set();
let app, page, stage = 'setup';
const origin = http.createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 200 : 405).end(); return; }
	let body = ''; for await (const chunk of req) { body += chunk; }
	const msg = JSON.parse(body); report.methods.push(msg.method);
	if (msg.id === undefined) { res.writeHead(202).end(); return; }
	const answer = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
	if (msg.method === 'initialize') { return answer({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Studio MCP fixture', version: '1.0.0' } }); }
	if (msg.method === 'tools/list') {
		return answer({
			tools: [
				{ name: 'fixture_read', description: 'Read fixture data', inputSchema: { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['value'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
				{ name: 'fixture_write', description: 'Write fixture data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, openWorldHint: false } },
				{ name: 'fixture_failure', description: 'Return error', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
			]
		});
	}
	if (msg.method === 'tools/call') { report.calls.push(msg.params.name); return answer({ content: [{ type: 'text', text: msg.params.name === 'fixture_failure' ? 'fixture failed' : 'MCP_RESULT_' + msg.params.arguments.value }], isError: msg.params.name === 'fixture_failure' }); }
	if (msg.method === 'ping') { return answer({}); }
	res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }));
});
origin.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(r => origin.listen(0, '127.0.0.1', r));
const proxy = http.createServer((req, res) => {
	report.proxyConnections++;
	const forward = http.request({ hostname: '127.0.0.1', port: origin.address().port, path: new URL(req.url).pathname, method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
	req.pipe(forward); forward.on('error', () => res.writeHead(502).end());
});
proxy.on('connect', (_req, socket, head) => {
	report.proxyConnections++;
	const upstream = net.connect(origin.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) { upstream.write(head); } socket.pipe(upstream); upstream.pipe(socket); });
	upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
	sockets.add(socket); sockets.add(upstream);
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
await fs.mkdir(path.join(profile, 'User'), { recursive: true }); await fs.mkdir(workspace);
await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'window.dialogStyle': 'custom', 'chat.mcp.autostart': 'never', 'ai.modelId': 'fixture', 'ai.modelName': 'Fixture' }));
const skillPath = path.join(workspace, '.agents', 'skills', 'fixture-skill', 'SKILL.md');
await fs.mkdir(path.dirname(skillPath), { recursive: true });
await fs.writeFile(skillPath, '---\nname: fixture-skill\ndescription: Fixture workflow\n---\nSKILL_RUNTIME_MARKER: organize the fixture results.\n');
try {
	stage = 'launch';
	app = await _electron.launch({ executablePath: path.resolve('scripts/code.sh'), args: [workspace, '--enable-smoke-test-driver', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--use-inmemory-secretstorage', '--user-data-dir=' + profile, '--extensions-dir=' + path.join(tmp, 'extensions')], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|API_KEY|SECRET|PASSWORD)/i.test(key))), VSCODE_SKIP_PRELAUNCH: '1' }, timeout: 75000 });
	page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.bringToFront();
	page.on('pageerror', e => report.errors.push(e.message));
	await page.locator('.studio-session-navigation').waitFor({ timeout: 45000 });
	stage = 'system resolver baseline';
	report.checks.systemResolverUnchanged = await app.evaluate(async ({ session }) => { const reference = session.fromPartition('mcp-system-reference', { cache: false }); await reference.setProxy({ mode: 'system' }); return await reference.resolveProxy('https://www.example.com') === await session.defaultSession.resolveProxy('https://www.example.com'); });
	assert.equal(report.checks.systemResolverUnchanged, true);
	// Isolated test process only: exercise the same Chromium resolver used by
	// production, routing an otherwise unresolvable host through our local fixture.
	await app.evaluate(async ({ session }, proxyPort) => { await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:' + proxyPort, proxyBypassRules: '<-loopback>' }); }, proxy.address().port);
	stage = 'register native MCP fixture';
	await page.evaluate(async port => {
		const base = location.href.split('/out/')[0] + '/out/'; const load = name => import(base + name);
		const [contrib, registry, mcp, tools, models, agent, aiModel, commands, obs, uri, cancel, bridge, ext, widget, chatService] = await Promise.all([
			load('vs/workbench/common/contributions.js'), load('vs/workbench/contrib/mcp/common/mcpRegistryTypes.js'), load('vs/workbench/contrib/mcp/common/mcpTypes.js'), load('vs/workbench/contrib/chat/common/tools/languageModelToolsService.js'), load('vs/workbench/contrib/chat/common/languageModels.js'), load('vs/workbench/contrib/chat/common/participants/chatAgents.js'), load('vs/platform/ai/browser/aiModelService.js'), load('vs/platform/commands/common/commands.js'), load('vs/base/common/observable.js'), load('vs/base/common/uri.js'), load('vs/base/common/cancellation.js'), load('vs/workbench/contrib/aiChat/browser/studioMcpTools.js'), load('vs/workbench/services/extensions/common/extensions.js'), load('vs/workbench/contrib/chat/browser/chat.js'), load('vs/workbench/contrib/chat/common/chatService/chatService.js'),
		]);
		contrib.WorkbenchContributionsRegistry.INSTANCE.instantiationService.invokeFunction(a => { window.cap = { registry: a.get(registry.IMcpRegistry), mcp: a.get(mcp.IMcpService), tools: a.get(tools.ILanguageModelToolsService), models: a.get(models.ILanguageModelsService), agents: a.get(agent.IChatAgentService), model: a.get(aiModel.IAIModelService), commands: a.get(commands.ICommandService), extensions: a.get(ext.IExtensionService), widgets: a.get(widget.IChatWidgetService), chat: a.get(chatService.IChatService), chatService, obs, URI: uri.URI, token: cancel.CancellationToken.None, createTools: bridge.createStudioMcpTools }; });
		const c = window.cap; await c.extensions.whenInstalledExtensionsRegistered();
		c.registration = c.registry.registerCollection({ id: 'fixture-collection', label: 'Fixture', remoteAuthority: null, trustBehavior: 0, scope: 1, configTarget: 3, order: 1, serverDefinitions: obs.observableValue('fixture', [{ id: 'fixture-server', label: 'Fixture Server', cacheNonce: 'v1', launch: { type: 2, uri: c.URI.parse('http://mcp-fixture.invalid:' + port + '/mcp'), headers: [] } }]) });
		await c.commands.executeCommand('ai.chat.open');
		c.widget = c.widgets.lastFocusedWidget ?? await c.widgets.revealWidget();
		c.chatModel = c.widget.viewModel.model;
		c.addRequest = message => {
			c.nativeRequest = c.chatModel.addRequest({ text: message, parts: [] }, { variables: [] }, 0);
			c.request = { sessionResource: c.chatModel.sessionResource, requestId: c.nativeRequest.id, agentId: 'ai-studio.chat', message, variables: { variables: [] }, location: 'panel' };
		};
		c.addRequest('Use the fixture');
	}, origin.address().port);
	await page.waitForFunction(() => window.cap.registry.delegates.get().length > 0, undefined, { polling: 100, timeout: 60000 });
	await page.waitForFunction(() => window.cap.mcp.servers.get().some(server => server.definition.id === 'fixture-server'), undefined, { polling: 100 });
	stage = 'start discovered MCP fixture';
	await page.evaluate(() => window.cap.commands.executeCommand('workbench.mcp.startServer', 'fixture-server', { waitForLiveTools: true }));
	await page.waitForFunction(() => [...window.cap.tools.getTools(undefined)].filter(t => t.source.type === 'mcp').length === 3);
	assert.ok(report.proxyConnections > 0); assert.ok(report.methods.includes('initialize')); report.checks.nativeMcpDiscoveryThroughProxy = true;
	stage = 'core agent calls real MCP';
	const result = await page.evaluate(async () => {
		const c = window.cap; const offers = []; let turn = 0, returned = '';
		Object.defineProperty(c.model, 'streamChat', { configurable: true, value: (messages, tools, _options, cb) => { offers.push(tools.map(t => t.name)); if (turn++ === 0) { const tool = tools.find(t => t.name.includes('fixture_read')); if (!tool) { throw Error('MCP tool not offered'); } cb.onToolUse(tool.name, { value: 42 }, 'fixture-call'); cb.onDone('tool_use'); } else { returned = JSON.stringify(messages.at(-1)); cb.onToken('done'); cb.onDone('end_turn'); } return new AbortController(); } });
		const result = await c.agents.invokeAgent('ai-studio.chat', c.request, () => { }, [], c.token);
		return { result, offers, returned };
	});
	assert.equal(result.result.errorDetails, undefined); assert.match(result.returned, /MCP_RESULT_42/); assert.ok(report.calls.includes('fixture_read')); report.checks.coreAgentExecutesNativeMcp = true;
	stage = 'discovered skill enters canonical agent';
	const skill = await page.evaluate(async skillPath => {
		const c = window.cap, base = location.href.split('/out/')[0] + '/out/';
		const [harness, contributions, attachments] = await Promise.all([import(base + 'vs/workbench/contrib/chat/common/customizationHarnessService.js'), import(base + 'vs/workbench/common/contributions.js'), import(base + 'vs/workbench/contrib/chat/common/attachments/chatVariableEntries.js')]);
		const h = contributions.WorkbenchContributionsRegistry.INSTANCE.instantiationService.invokeFunction(a => a.get(harness.ICustomizationHarnessService));
		const skills = await h.getSlashCommands(c.request.sessionResource, c.token);
		let content = '';
		Object.defineProperty(c.model, 'streamChat', { configurable: true, value: (messages, _tools, _options, cb) => { content = JSON.stringify(messages); cb.onToken('skill done'); cb.onDone('end_turn'); return new AbortController(); } });
		const entry = attachments.toPromptFileVariableEntry(c.URI.file(skillPath), attachments.PromptFileVariableKind.PromptFile, 'fixture-skill');
		c.addRequest('Use the skill');
		const result = await c.agents.invokeAgent('ai-studio.chat', { ...c.request, variables: { variables: [entry] } }, () => { }, [], c.token);
		return { result, content, discovered: skills.some(skill => skill.name === 'fixture-skill') };
	}, skillPath);
	assert.equal(skill.result.errorDetails, undefined); assert.equal(skill.discovered, true); assert.match(skill.content, /SKILL_RUNTIME_MARKER/); report.checks.skillDiscoveryAndAgentContext = true;
	stage = 'selection and disablement';
	const selection = await page.evaluate(() => { const c = window.cap, native = [...c.tools.getTools(undefined)].find(t => t.source.type === 'mcp' && t.displayName === 'fixture_read'); const all = c.createTools(c.request, c.tools, c.models); const filtered = c.createTools({ ...c.request, userSelectedTools: { [native.id]: false } }, c.tools, c.models); return { all: all.length, filtered: filtered.length }; });
	assert.deepEqual(selection, { all: 3, filtered: 2 }); report.checks.userToolSelectionRespected = true;
	const deselected = await page.evaluate(async () => {
		const c = window.cap, native = [...c.tools.getTools(undefined)].find(t => t.source.type === 'mcp' && t.displayName === 'fixture_read');
		const request = { ...c.request, userSelectedTools: { [native.id]: true } }, tool = c.createTools(request, c.tools, c.models).find(t => t.definition.name.includes('fixture_read'));
		request.userSelectedTools = { [native.id]: false };
		return tool.invoke({ id: 'deselected', name: tool.definition.name, input: { value: 'must-not-run' } }, new AbortController().signal);
	});
	assert.equal(deselected.outcome, 'denied'); report.checks.midRequestDeselectionPreventsExecution = true;
	stage = 'error forwarding';
	const failure = await page.evaluate(async () => { const c = window.cap, tool = c.createTools(c.request, c.tools, c.models).find(t => t.definition.name.includes('fixture_failure')); return tool.invoke({ id: 'failure', name: tool.definition.name, input: {} }, new AbortController().signal); });
	assert.equal(failure.outcome, 'error'); assert.match(failure.text, /fixture failed/); report.checks.mcpErrorPreserved = true;
	stage = 'denied tool approval';
	const deniedPromise = page.evaluate(async () => { const c = window.cap, tool = c.createTools(c.request, c.tools, c.models).find(t => t.definition.name.includes('fixture_write')); return tool.invoke({ id: 'denied', name: tool.definition.name, input: {} }, new AbortController().signal); });
	await page.waitForFunction(() => window.cap.nativeRequest.response.response.value.some(part => part.kind === 'toolInvocation' && part.state?.get().type === 1), undefined, { polling: 100 });
	await page.evaluate(() => {
		const c = window.cap, part = c.nativeRequest.response.response.value.find(part => part.kind === 'toolInvocation' && part.toolCallId === 'denied');
		c.chatService.IChatToolInvocation.confirmWith(part, { type: c.chatService.ToolConfirmKind.Denied });
	});
	const denied = await deniedPromise; assert.equal(denied.outcome, 'denied'); assert.ok(!report.calls.includes('fixture_write')); report.checks.nativeApprovalDenialPreventsExecution = true;
	stage = 'mid-request disabled and cancellation';
	const disabled = await page.evaluate(async () => { const c = window.cap, tool = c.createTools(c.request, c.tools, c.models)[0]; c.mcp.enablementModel.setEnabled('fixture-server', 0); await new Promise(r => setTimeout(r, 30)); return tool.invoke({ id: 'disabled', name: tool.definition.name, input: {} }, new AbortController().signal); });
	assert.equal(disabled.outcome, 'denied'); report.checks.disabledToolCannotExecute = true;
	const cancelled = await page.evaluate(async () => { const c = window.cap; c.mcp.enablementModel.setEnabled('fixture-server', 2); await new Promise(r => setTimeout(r, 30)); const tool = c.createTools(c.request, c.tools, c.models)[0], controller = new AbortController(); controller.abort(); return tool.invoke({ id: 'cancelled', name: tool.definition.name, input: {} }, controller.signal); });
	assert.equal(cancelled.outcome, 'cancelled'); report.checks.cancelledToolCannotExecute = true;
	report.pass = true;
} catch (error) {
	report.failure = { stage, message: error.stack }; process.exitCode = 1;
	if (page) {
		report.debug = await page.evaluate(async () => {
			const c = window.cap; if (!c) { return {}; }
			const base = location.href.split('/out/')[0] + '/out/';
			const customer = await import(base + 'vs/workbench/services/extensions/common/extHostCustomers.js');
			return { delegates: c.registry.delegates.get().length, collections: c.registry.collections.get().map(c => c.id), servers: c.mcp.servers.get().map(s => ({ id: s.definition.id, state: s.connectionState.get() })), registeredCustomer: customer.ExtHostCustomersRegistry.getNamedCustomers().map(([id]) => id.sid).filter(id => /Mcp/.test(id)), extensionHostManagers: c.extensions._extensionHostManagers?.map(m => ({ kind: m.kind, customers: m._customers?.map(c => c.constructor.name).filter(n => /Mcp/.test(n)) })) };
		}).catch(e => ({ debugError: String(e) }));
	}
}
finally {
	if (app) { await app.close().catch(() => { }); }
	for (const socket of sockets) { socket.destroy(); } proxy.close(); origin.close();
	await fs.writeFile(path.resolve('.build/ui-redesign/studio-mcp-runtime-report.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
}
