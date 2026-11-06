/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../src/vs/base/common/cancellation.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { resolveStudioAttachments } from '../../../src/vs/workbench/contrib/aiChat/browser/studioAttachments.js';
import type { IChatRequestVariableEntry } from '../../../src/vs/workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import type { IFileService } from '../../../src/vs/platform/files/common/files.js';
import type { AIMessage } from '../../../src/vs/platform/ai/common/aiTypes.js';
import { estimateAgentInputTokens } from '../../../src/vs/platform/ai/common/contextCompaction.js';
import { mergeArchivedReasoning } from '../../../src/vs/platform/ai/common/conversationMemory.js';
import { createAgentDeps, createTestAgent } from './helpers/testMocks.js';
import { Event } from '../../../src/vs/base/common/event.js';
import { CustomModelProvider } from '../../../src/vs/workbench/contrib/chat/browser/chatManagement/customModelProvider.js';
import type { ILanguageModelsConfigurationService } from '../../../src/vs/workbench/contrib/chat/common/languageModelsConfiguration.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const file = (path: string, kind: 'file' | 'directory' = 'file'): IChatRequestVariableEntry => ({ id: path, name: path.split('/').pop()!, kind, value: URI.file(path) });
function fixture(contents: Record<string, string> = {}) {
	const reads: { path: string; length: number | undefined }[] = [];
	const files = {
		realpath: async (uri: URI) => uri,
		readFile: async (uri: URI, options?: { length?: number }) => {
			reads.push({ path: uri.fsPath, length: options?.length });
			const data = VSBuffer.fromString(contents[uri.fsPath] ?? 'file content');
			return { value: data.slice(0, options?.length) };
		},
	} as unknown as IFileService;
	return { files, reads };
}

suite('Explicit composer attachments', () => {
	test('model vision is declared explicitly instead of inferred from arbitrary names', async () => {
		const provider = new CustomModelProvider({
			onDidChangeLanguageModelGroups: Event.None,
			getLanguageModelsProviderGroups: () => ['enabled', 'disabled', 'gpt-5.2'].map((name, i) => ({ vendor: 'ai-studio', name, settings: { [name]: { modelId: name, ...(i < 2 ? { vision: i === 0 } : {}) } } })),
		} as ILanguageModelsConfigurationService);
		try {
			assert.deepStrictEqual((await provider.provideLanguageModelChatInfo({}, CancellationToken.None)).map(model => model.metadata.capabilities?.vision), [true, false, false]);
		} finally { provider.dispose(); }
	});

	test('reads explicitly selected external skill and text, deduplicates and never traverses directories', async () => {
		const { files, reads } = fixture({ '/outside/SKILL.md': 'Use this fixture skill.', '/project/note.txt': 'Text fixture.' });
		const skill: IChatRequestVariableEntry = { ...file('/outside/SKILL.md'), kind: 'promptFile', value: URI.file('/outside/SKILL.md'), isRoot: true, automaticallyAdded: false, modelDescription: '' };
		const result = await resolveStudioAttachments([skill, file('/project/note.txt'), file('/project/note.txt'), file('/project/folder', 'directory'), { ...skill, id: 'automatic', automaticallyAdded: true }], files, CancellationToken.None);
		assert.deepStrictEqual(reads.map(read => read.path), ['/outside/SKILL.md', '/project/note.txt']);
		assert.ok(result.text.includes('Use this fixture skill.') && result.text.includes('Text fixture.'));
		assert.ok(result.text.includes('/project/folder') && result.text.includes('未自动读取目录内容'));
		assert.deepStrictEqual(result.warnings, []);
	});

	test('blocks sensitive paths and aliases before reading, including image references', async () => {
		const { files, reads } = fixture();
		files.realpath = async uri => uri.path.includes('alias') ? URI.file('/private/.env') : uri;
		const result = await resolveStudioAttachments([file('/repo/.env'), file('/repo/alias.txt'), { kind: 'image', id: 'image', name: 'alias.png', value: png, references: [{ kind: 'reference', reference: URI.file('/repo/alias.png') }] }], files, CancellationToken.None);
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(result.images.length, 0);
		assert.strictEqual(result.warnings.length, 3);
		assert.ok(result.warnings.every(warning => warning.includes('敏感文件')));
	});

	test('caps reads and total text, reports truncation and binary path-only context', async () => {
		const { files, reads } = fixture({ '/a.txt': 'a'.repeat(100_000), '/b.txt': 'b'.repeat(100_000), '/c.txt': 'c'.repeat(100_000), '/document.pdf': '%PDF file' });
		const binary = await resolveStudioAttachments([file('/document.pdf')], files, CancellationToken.None);
		assert.ok(!binary.text.includes('%PDF'));
		assert.ok(binary.warnings[0].includes('仅发送文件路径'));
		const result = await resolveStudioAttachments([file('/a.txt'), file('/b.txt'), file('/c.txt')], files, CancellationToken.None);
		assert.ok(reads.every(read => read.length === 24 * 1024 + 1));
		assert.strictEqual(reads.filter(read => read.path === '/c.txt').length, 0);
		assert.strictEqual(result.warnings.length, 3);
		assert.ok(result.text.length < 50_000);
	});

	test('uses decoded image bytes MIME and omits unsupported or oversized images', async () => {
		const { files, reads } = fixture();
		const huge = new Uint8Array(5 * 1024 * 1024 + 1); huge.set(png);
		const result = await resolveStudioAttachments([
			{ kind: 'image', id: 'resized', name: 'source.gif', value: png },
			{ kind: 'image', id: 'url', name: 'remote', value: 'https://example.invalid/image.png' },
			{ kind: 'image', id: 'huge', name: 'huge.png', value: huge },
		], files, CancellationToken.None);
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(result.images.length, 1);
		assert.deepStrictEqual(result.images[0].source, { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
		assert.strictEqual(result.warnings.length, 2);
	});

	test('cancellation after async resolution prevents further reads and delivery', async () => {
		const { files, reads } = fixture();
		const cts = new CancellationTokenSource();
		files.realpath = async uri => { cts.cancel(); return uri; };
		try { await assert.rejects(resolveStudioAttachments([file('/one.txt'), file('/two.txt')], files, cts.token), /Canceled/); }
		finally { cts.dispose(); }
		assert.strictEqual(reads.length, 0);
	});

	test('real agent retains current images through tool continuation but never into the next turn', async () => {
		const deps = createAgentDeps();
		deps.contextService.buildContext = async input => [...input.memory.toMessages(), { role: 'user', content: input.instruction }];
		const requests: AIMessage[][] = [];
		deps.aiModelService.streamChat = (messages, _tools, _options, callbacks) => {
			requests.push(structuredClone(messages));
			if (requests.length === 1) { callbacks.onToolUse('TaskList', {}, 'tasks'); callbacks.onDone('tool_use'); }
			else { callbacks.onToken('done'); callbacks.onDone('end_turn'); }
			return new AbortController();
		};
		const agent = createTestAgent(deps);
		try {
			await agent.run('question with image', { sessionId: 'one', images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] });
			assert.ok(requests.slice(0, 2).every(messages => JSON.stringify(messages).includes('iVBORw0KGgo=')));
			await agent.run('next turn', { sessionId: 'two', history: [] });
			assert.ok(!JSON.stringify(requests[2]).includes('iVBORw0KGgo='));
		} finally { agent.dispose(); }
	});

	test('image transport bytes do not inflate text token estimates', () => {
		const image = (data: string): AIMessage[] => [{ role: 'user', content: [{ type: 'text', text: 'image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }];
		assert.strictEqual(estimateAgentInputTokens(image('short'), []), estimateAgentInputTokens(image('a'.repeat(1_000_000)), []));
		assert.ok(estimateAgentInputTokens(image('short'), []) >= 8192);
		const payload = (data: string): AIMessage[] => [{ role: 'assistant', content: [{ type: 'tool_use', id: 'write', name: 'write_file', input: { type: 'image', source: { type: 'base64', data } } }] }];
		assert.ok(estimateAgentInputTokens(payload('a'.repeat(1_000_000)), []) > estimateAgentInputTokens(payload('short'), []) + 100_000, 'image-shaped tool arguments are still text');
	});

	test('restores attached text only for unambiguous unchanged native request identity', () => {
		const archived = [{ requestId: 'one', sourceUserMessage: 'question', userMessage: 'question\nattached content', assistantMessage: 'answer', timestamp: 1 }];
		const history = [{ requestId: 'one', userMessage: 'question', assistantMessage: 'answer' }, { requestId: 'one', userMessage: 'edited', assistantMessage: 'answer' }, { requestId: 'two', userMessage: 'question', assistantMessage: 'answer' }];
		assert.deepStrictEqual(mergeArchivedReasoning(history, archived).map(turn => turn.userMessage), ['question\nattached content', 'edited', 'question']);
		assert.strictEqual(mergeArchivedReasoning(history, [...archived, ...archived])[0].userMessage, 'question');
	});
});
