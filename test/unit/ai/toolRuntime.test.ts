/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 * AI Studio — scheduling, tool policy and chat session regressions.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../src/vs/base/common/async.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import type { AIMessage, AIMessageContent, AIStreamCallbacks, AITool } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { getAgentTools } from '../../../src/vs/platform/ai/common/agentTools.js';
import { executeToolBatch, toolResult, validateToolCall, type AgentToolCall } from '../../../src/vs/platform/ai/common/toolRuntime.js';
import { createAgentDeps, createTestAgent, MockConfigurationService } from './helpers/testMocks.js';
import type { CommandApprovalRequest } from '../../../src/vs/platform/ai/browser/aiAgentService.js';

function call(id: string, name: string, input: Record<string, unknown> = {}): AgentToolCall {
	return { id, name, input };
}

function emitCalls(cb: AIStreamCallbacks, ...calls: AgentToolCall[]): void {
	for (const { id, name, input } of calls) { cb.onToolUse(name, input, id); }
	cb.onDone('tool_use');
}

type ModelTurn = (cb: AIStreamCallbacks, messages: AIMessage[], tools: AITool[]) => void;

function scripted(...turns: ModelTurn[]) {
	const deps = createAgentDeps();
	// These tests exercise approvals; native sandbox enforcement has a separate suite.
	(deps.configurationService as unknown as MockConfigurationService).setValue('ai.commandSandbox', 'off');
	const invoked: AIMessage[][] = [];
	deps.aiModelService.streamChat = (messages, tools, _options, cb) => {
		const handler = turns[invoked.length];
		invoked.push(structuredClone(messages));
		if (!handler) { cb.onError(new Error('400: unexpected model request')); }
		else { handler(cb, messages, tools); }
		return new AbortController();
	};
	deps.workspaceContextService.getWorkspace = () => ({ folders: [{ uri: URI.file('/tmp/test-workspace') }] }) as ReturnType<typeof deps.workspaceContextService.getWorkspace>;
	return { agent: createTestAgent(deps), deps, invoked };
}

const finish: ModelTurn = cb => { cb.onToken('完成'); cb.onDone('end_turn'); };
const results = (messages: AIMessage[]) => messages.findLast(msg => msg.role === 'tool')!.content as AIMessageContent[];

suite('Tool runtime', () => {
	test('output truncation marks the agent as failed without replaying the same request', async () => {
		const { agent, invoked } = scripted(cb => {
			cb.onToken('unfinished');
			cb.onDone('max_tokens');
		});
		try {
			await agent.run('long response');
			assert.strictEqual(agent.status, 'error');
			assert.strictEqual(invoked.length, 1);
			assert.strictEqual(agent.steps.at(-1)?.type, 'error');
			assert.match(agent.steps.at(-1)!.content, /输出上限/);
		} finally { agent.dispose(); }
	});

	test('malformed nested question choices fail before opening the user prompt', () => {
		const ask = getAgentTools().find(t => t.name === 'AskUserQuestion')!;
		assert.match(validateToolCall(call('ask', ask.name, { question: '选哪个？', options: [null] }), ask)!, /options\[0\]/);
		assert.match(validateToolCall(call('ask', ask.name, { question: '选哪个？', options: [{}] }), ask)!, /label/);
	});
	test('up to four consecutive reads overlap, results remain ordered, and mutations form a barrier', async () => {
		const calls = ['read_file', 'search_content', 'TaskList', 'list_directory', 'read_lints', 'edit_file', 'read_file'].map((name, i) => call(String(i), name));
		const started: string[] = [];
		const gates = calls.map(() => new DeferredPromise<void>());
		const signals = calls.map(() => new DeferredPromise<void>());
		const run = executeToolBatch(calls, async c => {
			started.push(c.id);
			await signals[+c.id].complete();
			await gates[+c.id].p;
			return toolResult(c.id, c.name, 'success');
		}, new AbortController().signal);
		await signals[3].p;
		assert.deepStrictEqual(started, ['0', '1', '2', '3']);
		for (const i of [3, 2, 1, 0]) { await gates[i].complete(); }
		await signals[4].p;
		assert.deepStrictEqual(started.slice(4), ['4']);
		await gates[4].complete();
		await signals[5].p;
		assert.deepStrictEqual(started.slice(5), ['5']);
		await gates[5].complete();
		await signals[6].p;
		await gates[6].complete();
		assert.deepStrictEqual((await run).map(b => b.tool_use_id), calls.map(c => c.id));
	});

	test('cancelling a read batch never starts its queued mutation', async () => {
		const abort = new AbortController();
		const pending = new DeferredPromise<void>();
		const started: string[] = [];
		const run = executeToolBatch([call('a', 'read_file'), call('b', 'write_file')], async c => {
			started.push(c.id);
			await pending.p;
			return toolResult(c.id, '', 'success');
		}, abort.signal);
		abort.abort();
		await pending.complete();
		await assert.rejects(run, { name: 'AbortError' });
		assert.deepStrictEqual(started, ['a']);
	});

	test('plan permissions are rechecked between calls and after review; bad arguments never dispatch', async () => {
		const { agent, invoked } = scripted(
			cb => emitCalls(cb, call('enter', 'EnterPlanMode'), call('forged', 'write_file', { path: 'bad', content: 'x' })),
			cb => emitCalls(cb, call('plan', 'ExitPlanMode', { content: '先检查版本。' }), call('early', 'run_command', { command: 'pwd' })),
			cb => emitCalls(cb, call('invalid', 'write_file', { path: 'bad', content: 9 })), finish,
		);
		const listener = agent.onDidEnterPlanMode(event => { assert.strictEqual(event.content, '先检查版本。'); agent.approvePlan(true); });
		try {
			await agent.run('plan');
			assert.deepStrictEqual(agent.steps.filter(s => s.type === 'tool_result').map(s => [s.toolCallId, s.outcome]), [
				['enter', 'success'], ['forged', 'denied'], ['plan', 'success'], ['early', 'denied'], ['invalid', 'error'],
			]);
			assert.deepStrictEqual(results(invoked[1]).map(b => [b.tool_use_id, b.is_error]), [['enter', false], ['forged', true]]);
			assert.strictEqual(results(invoked[2])[1].is_error, true);
			assert.strictEqual(results(invoked[3])[0].is_error, true);
		} finally { listener.dispose(); agent.dispose(); }
	});

	test('commands require one-shot approval scoped to the active chat and stop never starts a pending command', async () => {
		const request: ModelTurn = cb => emitCalls(cb, call('same-id', 'run_command', { command: 'npm test' }));
		const { agent, deps, invoked } = scripted(request, finish, request, finish, request);
		(deps.configurationService as unknown as MockConfigurationService).setValue('ai.commandApproval', 'all');
		const original = Object.getOwnPropertyDescriptor(globalThis, 'vscode');
		const spawned: string[] = [];
		Object.defineProperty(globalThis, 'vscode', {
			configurable: true, value: {
				ipcRenderer: {
					invoke: async (_: string, args: { command: string }) => {
						spawned.push(args.command);
						return { stdout: 'passed', stderr: '', exitCode: 0 };
					}
				}
			}
		});
		const requests: CommandApprovalRequest[] = [];
		const listener = agent.onDidRequestCommandApproval(event => {
			requests.push(event);
			assert.strictEqual(agent.steps.at(-1)?.toolCallId, event.toolCallId);
			assert.strictEqual(agent.status, 'waiting_for_approval');
			if (requests.length === 1) { agent.respondToCommandApproval(event.requestId, false); }
			if (requests.length === 2) {
				agent.respondToCommandApproval(requests[0].requestId, false);
				agent.respondToCommandApproval(event.requestId, true);
			}
			if (requests.length === 3) { agent.stop(); }
		});
		try {
			for (const sessionId of ['one', 'two', 'three']) { await agent.run('command', { sessionId, history: [] }); }
			assert.strictEqual(requests.length, 3);
			assert.strictEqual(new Set(requests.map(r => r.requestId)).size, 3);
			assert.strictEqual(spawned.length, 1);
			assert.strictEqual(results(invoked[1])[0].is_error, true);
			assert.strictEqual(results(invoked[3])[0].is_error, false);
			assert.strictEqual(agent.steps.at(-1)?.outcome, 'cancelled');
			assert.strictEqual(invoked.length, 5);
		} finally {
			listener.dispose(); agent.dispose();
			if (original) { Object.defineProperty(globalThis, 'vscode', original); }
			else { Reflect.deleteProperty(globalThis, 'vscode'); }
		}
	});

	test('child agents execute real reads; read-only children cannot forge writes, and nested commands reach parent approval', async () => {
		const child = (id: string, type: string) => call(id, 'Agent', { prompt: 'check it', description: 'check', subagent_type: type });
		const { agent, deps, invoked } = scripted(
			cb => emitCalls(cb, child('explore', 'Explore')),
			cb => emitCalls(cb, call('read', 'read_file', { path: 'actual.txt' }), call('write', 'write_file', { path: 'bad', content: 'x' })),
			finish,
			cb => emitCalls(cb, child('verify', 'verification')),
			cb => emitCalls(cb, call('shell', 'run_command', { command: 'npm test' })),
			finish, finish,
		);
		deps.fileService.readFile = async () => ({ value: VSBuffer.fromString('real contents') }) as Awaited<ReturnType<typeof deps.fileService.readFile>>;
		const seen: CommandApprovalRequest[] = [];
		const listener = agent.onDidRequestCommandApproval(e => { seen.push(e); agent.respondToCommandApproval(e.requestId, false); });
		try {
			await agent.run('delegate', { sessionId: 'child', history: [] });
			assert.match(String(results(invoked[2])[0].content), /real contents/);
			assert.strictEqual(results(invoked[2])[1].is_error, true);
			assert.strictEqual(seen.length, 1);
			assert.strictEqual(seen[0].toolCallId, 'verify');
			assert.strictEqual(results(invoked[5])[0].is_error, true);
		} finally { listener.dispose(); agent.dispose(); }
	});

	test('plan review tokens reject a late answer from another session', async () => {
		const plan: ModelTurn = cb => emitCalls(cb, call('mode', 'EnterPlanMode'));
		const present: ModelTurn = cb => emitCalls(cb, call('plan', 'ExitPlanMode', { content: '计划' }));
		const { agent, invoked } = scripted(plan, present, plan, present, finish);
		const tokens: string[] = [];
		const listener = agent.onDidEnterPlanMode(e => {
			tokens.push(e.requestId);
			if (tokens.length > 1) { agent.approvePlan(false, tokens[0]); }
			agent.approvePlan(tokens.length > 1, e.requestId);
		});
		try {
			await agent.run('first', { sessionId: 'first', history: [] });
			await agent.run('second', { sessionId: 'second', history: [] });
			assert.strictEqual(tokens.length, 2);
			assert.strictEqual(invoked.length, 5);
			assert.strictEqual(agent.steps.at(-1)?.content, '完成');
		} finally { listener.dispose(); agent.dispose(); }
	});

	test('stopping a child blocked on approval cancels the parent batch and skips the queued write', async () => {
		const { agent, invoked } = scripted(
			cb => emitCalls(cb, call('child', 'Agent', { prompt: 'test', description: 'test', subagent_type: 'verification' }), call('late', 'write_file', { path: 'bad', content: 'bad' })),
			cb => emitCalls(cb, call('shell', 'run_command', { command: 'npm test' })),
		);
		const listener = agent.onDidRequestCommandApproval(() => agent.stop());
		try {
			await agent.run('cancel child', { sessionId: 'stop', history: [] });
			assert.strictEqual(invoked.length, 2);
			assert.deepStrictEqual(agent.steps.filter(s => s.type === 'tool_result').map(s => [s.toolCallId, s.outcome]), [['child', 'cancelled']]);
			assert.strictEqual(agent.isRunning, false);
		} finally { listener.dispose(); agent.dispose(); }
	});

	test('native history is authoritative when switching conversations', async () => {
		const { agent, deps } = scripted(finish, finish, finish);
		const history: string[][] = [];
		deps.contextService.buildContext = async input => {
			history.push(input.memory.turns.map(t => t.userMessage));
			return [{ role: 'user', content: input.instruction }];
		};
		try {
			await agent.run('上海', { sessionId: 'one', history: [{ userMessage: '北京', assistantMessage: '历史' }] });
			await agent.run('武汉', { sessionId: 'two', history: [] });
			await agent.run('广州', { sessionId: 'one', history: [{ userMessage: '北京', assistantMessage: '历史' }, { userMessage: '上海', assistantMessage: '完成' }] });
			assert.deepStrictEqual(history, [['北京'], [], ['北京', '上海']]);
			assert.strictEqual(agent.sessionId, 'one');
		} finally { agent.dispose(); }
	});

	test('commands without an approval listener fail closed and the model receives the refusal', async () => {
		const { agent, invoked } = scripted(cb => emitCalls(cb, call('shell', 'run_command', { command: 'npm test' })), finish);
		try {
			await agent.run('run the test', { sessionId: 'no-ui', history: [] });
			assert.strictEqual(agent.steps.find(s => s.type === 'tool_result')?.outcome, 'denied');
			assert.strictEqual(results(invoked[1])[0].is_error, true);
		} finally { agent.dispose(); }
	});
});
