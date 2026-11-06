/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Uses the published OpenCode V2 host and its real session/database implementation.
// The caller owns the Electron host and the system-proxy transport/HTTP fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const fixtureModelID = 'fixture-model';
export const fixtureKey = 'ai-studio-fixture-only';
export const fixtureReply = 'AI_STUDIO_OPENCODE_OK';
const denyAll = { action: '*', resource: '*', effect: 'deny' };

function assistantText(messages) {
	return messages.filter(message => message.type === 'assistant')
		.flatMap(message => message.content ?? [])
		.filter(content => content.type === 'text')
		.map(content => content.text).join('\n');
}

async function eventually(read, predicate, label, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (predicate(value)) { return value; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

export async function runScenario({ workspace, database, configDir, modelBaseURL, fetch: transport, report = {}, exerciseCancellation = false, exerciseTools = false, exerciseRejectedPermission = false, restoreSessionID, expectedMessageIDs }) {
	for (const directory of [workspace, configDir, path.dirname(database)]) { await mkdir(directory, { recursive: true }); }
	const result = { sdkVersion: '2.2.5', modelBaseURL, phases: [] };
	const record = (phase, values = {}) => {
		const item = { phase, ...values };
		result.phases.push(item);
		if (typeof report === 'function') { report(item); }
		else { Object.assign(report, result); }
	};
	// Install before dynamic imports: the host's HTTP layers use the caller's transport.
	// This test runs in its own process and restores the global at completion.
	const originalFetch = globalThis.fetch;
	if (transport) { globalThis.fetch = transport; }
	let host;
	const request = { signal: AbortSignal.timeout(60000) };
	try {
		const { OpenCode } = await import('@opencode/sdk');
		record('imported', { electron: process.versions.electron, node: process.versions.node });
		const settings = {
			model: `fixture/${fixtureModelID}`,
			default_agent: 'build',
			update: 'disable', share: 'disabled', snapshots: false, warming: false,
			providers: {
				fixture: {
					name: 'Local validation fixture',
					package: '@opencode/ai/providers/openai-compatible',
					settings: { baseURL: modelBaseURL, apiKey: fixtureKey },
					models: {
						[fixtureModelID]: {
							name: 'Validation fixture', limit: { context: 32000, output: 2048 },
							capabilities: { tools: true, input: ['text'], output: ['text'], reasoning: { supported: false } },
						},
					},
				},
			},
		};
		const options = {
			database: { path: database },
			models: { fetch: false, snapshot: false },
			config: { directory: configDir, project: false, claude: false, content: JSON.stringify(settings) },
			fs: { filewatcher: false, fff: false },
			log: { level: 'warn', emit: entry => record('sdk-log', { message: entry.message }) },
		};
		host = await OpenCode.create(options);
		record('host-created');
		if (restoreSessionID) {
			const session = await host.sessions.get({ sessionID: restoreSessionID }, request);
			const saved = await host.message.list({ sessionID: restoreSessionID, order: 'asc', limit: 100 }, request);
			assert.equal(session.outcome, 'succeeded');
			assert.ok(assistantText(saved.data).includes(fixtureReply));
			if (expectedMessageIDs) { assert.deepEqual(saved.data.map(message => message.id), expectedMessageIDs); }
			record('process-restart-restored', { sessionID: restoreSessionID, messageCount: saved.data.length, sameMessageIDs: !!expectedMessageIDs });
			return { ...result, sessionID: restoreSessionID, messageIDs: saved.data.map(message => message.id), success: true };
		}
		const session = await host.sessions.create({
			location: { directory: workspace }, model: { providerID: 'fixture', id: fixtureModelID },
			permissions: [denyAll],
			title: 'AI Studio isolated SDK validation', metadata: { validation: 'ai-studio' },
		}, request);
		result.sessionID = session.id;
		record('session-created', { sessionID: session.id });
		await host.sessions.prompt({ sessionID: session.id, text: `Reply with ${fixtureReply}. Do not use any tools.` }, request);
		await host.sessions.wait({ sessionID: session.id }, request);
		const completed = await host.sessions.get({ sessionID: session.id }, request);
		const messages = await host.message.list({ sessionID: session.id, order: 'asc', limit: 100 }, request);
		const text = assistantText(messages.data);
		assert.equal(completed.outcome, 'succeeded', JSON.stringify(messages.data));
		assert.ok(text.includes(fixtureReply), `Unexpected assistant output: ${text}`);
		assert.ok(messages.data.some(message => message.type === 'assistant' && message.time.completed));
		record('prompt-completed', { outcome: completed.outcome, text, messageCount: messages.data.length });
		const messageIDs = messages.data.map(message => message.id);
		result.messageIDs = messageIDs;
		await host.close(); host = undefined;
		record('host-closed');
		host = await OpenCode.create(options);
		const restored = await host.sessions.get({ sessionID: session.id }, request);
		const restoredMessages = await host.message.list({ sessionID: session.id, order: 'asc', limit: 100 }, request);
		assert.equal(restored.id, session.id);
		assert.deepEqual(restoredMessages.data.map(message => message.id), messageIDs);
		assert.equal(assistantText(restoredMessages.data), text);
		record('database-reopened', { sessionID: restored.id, messageCount: restoredMessages.data.length, sameMessageIDs: true });

		if (exerciseTools) {
			const target = path.join(workspace, 'read-check.txt');
			await writeFile(target, 'AI_STUDIO_FILE_CONTENT\n', 'utf8');
			const toolSession = await host.sessions.create({
				location: { directory: workspace }, model: { providerID: 'fixture', id: fixtureModelID },
				permissions: [denyAll, { action: 'read', resource: '*', effect: 'ask' }],
			}, request);
			await host.sessions.prompt({ sessionID: toolSession.id, text: `AI_STUDIO_READ: Read ${target} with the read tool, then report its contents.` }, request);
			const approvals = await eventually(() => host.permission.list({ sessionID: toolSession.id }, request), items => items.some(item => item.action === 'read'), 'the native read approval');
			const approval = approvals.find(item => item.action === 'read');
			const beforeApproval = await host.message.list({ sessionID: toolSession.id, order: 'asc', limit: 100 }, request);
			assert.ok(!JSON.stringify(beforeApproval.data).includes('AI_STUDIO_FILE_CONTENT'), 'file contents must not be returned before permission is granted');
			record('approval-pending', { sessionID: toolSession.id, requestID: approval.id, action: approval.action, toolCallID: approval.source?.id });
			await host.permission.reply({ sessionID: toolSession.id, requestID: approval.id, decision: 'once' }, request);
			await host.sessions.wait({ sessionID: toolSession.id }, request);
			const toolMessages = await host.message.list({ sessionID: toolSession.id, order: 'asc', limit: 100 }, request);
			const executed = toolMessages.data.filter(message => message.type === 'assistant').flatMap(message => message.content ?? []).filter(content => content.type === 'tool' && content.state.status === 'completed');
			assert.ok(executed.some(tool => JSON.stringify(tool.state.content).includes('AI_STUDIO_FILE_CONTENT')), JSON.stringify(toolMessages.data));
			assert.equal((await host.sessions.get({ sessionID: toolSession.id }, request)).outcome, 'succeeded');
			record('tool-approved-and-completed', { sessionID: toolSession.id, tools: executed.map(tool => tool.name), toolCallIDs: executed.map(tool => tool.id) });

			const webSession = await host.sessions.create({
				location: { directory: workspace }, model: { providerID: 'fixture', id: fixtureModelID },
				permissions: [denyAll, { action: 'webfetch', resource: '*', effect: 'ask' }],
			}, request);
			await host.sessions.prompt({ sessionID: webSession.id, text: 'AI_STUDIO_WEBFETCH_TOOL: Fetch http://page.fixture.invalid/page with the webfetch tool and report the page text.' }, request);
			const webApprovals = await eventually(() => host.permission.list({ sessionID: webSession.id }, request), items => items.some(item => item.action === 'webfetch'), 'the native webfetch approval');
			const webApproval = webApprovals.find(item => item.action === 'webfetch');
			const beforeWebApproval = await host.message.list({ sessionID: webSession.id, order: 'asc', limit: 100 }, request);
			assert.ok(!JSON.stringify(beforeWebApproval.data).includes('SDK_WEBFETCH_OK'));
			record('webfetch-approval-pending', { sessionID: webSession.id, requestID: webApproval.id, action: webApproval.action });
			await host.permission.reply({ sessionID: webSession.id, requestID: webApproval.id, decision: 'once' }, request);
			await host.sessions.wait({ sessionID: webSession.id }, request);
			const webMessages = await host.message.list({ sessionID: webSession.id, order: 'asc', limit: 100 }, request);
			const webTools = webMessages.data.filter(message => message.type === 'assistant').flatMap(message => message.content ?? []).filter(content => content.type === 'tool' && content.state.status === 'completed');
			assert.ok(webTools.some(tool => JSON.stringify(tool.state.content).includes('SDK_WEBFETCH_OK')), JSON.stringify(webMessages.data));
			assert.equal((await host.sessions.get({ sessionID: webSession.id }, request)).outcome, 'succeeded');
			record('webfetch-approved-and-completed', { sessionID: webSession.id, tools: webTools.map(tool => tool.name) });
		}

		if (exerciseRejectedPermission) {
			const target = path.join(workspace, 'read-check.txt');
			await writeFile(target, 'AI_STUDIO_FILE_CONTENT\n', 'utf8');
			const deniedSession = await host.sessions.create({
				location: { directory: workspace }, model: { providerID: 'fixture', id: fixtureModelID },
				permissions: [denyAll, { action: 'read', resource: '*', effect: 'ask' }],
			}, request);
			await host.sessions.prompt({ sessionID: deniedSession.id, text: `AI_STUDIO_READ: Read ${target} with the read tool, then report its contents.` }, request);
			const approvals = await eventually(() => host.permission.list({ sessionID: deniedSession.id }, request), items => items.some(item => item.action === 'read'), 'the read approval to reject');
			await host.permission.reply({ sessionID: deniedSession.id, requestID: approvals.find(item => item.action === 'read').id, decision: 'reject' }, request);
			await host.sessions.wait({ sessionID: deniedSession.id }, request);
			const deniedMessages = await host.message.list({ sessionID: deniedSession.id, order: 'asc', limit: 100 }, request);
			assert.ok(!JSON.stringify(deniedMessages.data).includes('AI_STUDIO_FILE_CONTENT'), 'rejected read must not expose file contents');
			const rejectedTools = deniedMessages.data.filter(message => message.type === 'assistant').flatMap(message => message.content ?? []).filter(content => content.type === 'tool' && content.name === 'read' && content.state.status === 'error');
			assert.ok(rejectedTools.length > 0, 'rejected read must be recorded as an unsuccessful tool call');
			assert.equal((await host.permission.list({ sessionID: deniedSession.id }, request)).length, 0);
			record('tool-rejected', { sessionID: deniedSession.id, outcome: (await host.sessions.get({ sessionID: deniedSession.id }, request)).outcome, toolCallIDs: rejectedTools.map(tool => tool.id) });
		}

		if (exerciseCancellation) {
			// Fixture must leave this prompt's streaming response open until its connection is aborted.
			const slow = await host.sessions.create({ location: { directory: workspace }, model: { providerID: 'fixture', id: fixtureModelID }, permissions: [denyAll] }, request);
			// Streaming text is not yet persisted in message.list. Subscribe before starting
			// the prompt and wait for the native stream's connection acknowledgement.
			const eventController = new AbortController();
			const events = host.events.subscribe({
				types: ['session.text.delta'],
				signal: AbortSignal.any([eventController.signal, AbortSignal.timeout(15000)]),
			})[Symbol.asyncIterator]();
			try {
				const connected = await events.next();
				assert.equal(connected.value?.type, 'server.connected', 'event stream must be connected before the prompt');
				await host.sessions.prompt({ sessionID: slow.id, text: 'AI_STUDIO_CANCEL: begin a long response and wait.' }, request);
				let streamedText = '';
				while (!streamedText.includes('AI_STUDIO_WAITING')) {
					const next = await events.next();
					assert.ok(!next.done, 'event stream ended before the slow model produced text');
					if (next.value.type === 'session.text.delta' && next.value.data.sessionID === slow.id) {
						streamedText += next.value.data.delta;
					}
				}
				record('slow-stream-started', { sessionID: slow.id, text: streamedText });
			} finally {
				eventController.abort();
				await events.return?.();
			}
			await host.sessions.interrupt({ sessionID: slow.id }, request);
			await host.sessions.wait({ sessionID: slow.id }, request);
			const interrupted = await host.sessions.get({ sessionID: slow.id }, request);
			assert.equal(interrupted.outcome, 'interrupted');
			record('cancelled', { sessionID: slow.id, outcome: interrupted.outcome });
		}
		result.success = true;
		return result;
	} catch (error) {
		record('failed', { error: error instanceof Error ? error.stack : String(error) });
		throw error;
	} finally {
		try { await host?.close(); }
		finally { if (transport) { globalThis.fetch = originalFetch; } }
	}
}
