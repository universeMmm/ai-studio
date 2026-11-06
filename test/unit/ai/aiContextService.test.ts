/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mock, upcastPartial } from '../../../src/vs/base/test/common/mock.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { EditorType } from '../../../src/vs/editor/common/editorCommon.js';
import type { IDiffEditor, ICodeEditor } from '../../../src/vs/editor/browser/editorBrowser.js';
import type { ITextModel } from '../../../src/vs/editor/common/model.js';
import { AIContextService } from '../../../src/vs/platform/ai/browser/aiContextService.js';
import { ConversationMemory } from '../../../src/vs/platform/ai/common/conversationMemory.js';
import { UserMemoryStore } from '../../../src/vs/platform/ai/common/userMemoryStore.js';
import type { IEditorService } from '../../../src/vs/workbench/services/editor/common/editorService.js';
import { createAgentDeps, MockFileService } from './helpers/testMocks.js';

suite('Desktop chat context', () => {
	test('excludes read-only agent diff snapshots when continuing a task from comparison', () => {
		const deps = createAgentDeps();
		const snapshot = upcastPartial<ITextModel>({ uri: URI.from({ scheme: 'ai-studio-change', path: '/file.ts' }) });
		const modifiedEditor = upcastPartial<ICodeEditor>({ getModel: () => snapshot });
		const diff = upcastPartial<IDiffEditor>({ getEditorType: () => EditorType.IDiffEditor, getModifiedEditor: () => modifiedEditor });
		const context = new AIContextService(upcastPartial({ activeTextEditorControl: diff }), deps.fileService, deps.logService,
			deps.workspaceContextService, new UserMemoryStore(deps.fileService, deps.logService), deps.configurationService);
		try { assert.deepEqual(context.getEditorContext(), { filePath: '', languageId: '', line: 0, column: 0, selection: '' }); }
		finally { context.dispose(); }
	});
	test('includes project rules without a Node process global in the renderer', async () => {
		const deps = createAgentDeps();
		const fileService = deps.fileService;
		assert.ok(fileService instanceof MockFileService);
		fileService.setFile('/tmp/test-workspace/CLAUDE.md', 'Sandbox project rule');
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
		Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
		try {
			const memory = new UserMemoryStore(fileService, deps.logService);
			const context = new AIContextService(new (mock<IEditorService>())(), fileService, deps.logService,
				deps.workspaceContextService, memory, deps.configurationService);
			try {
				const messages = await context.buildContext({ instruction: 'Hello', memory: new ConversationMemory(), topK: 1 });
				assert.match(String(messages[0].content), /Sandbox project rule/);
				assert.deepEqual(messages.at(-1), { role: 'user', content: 'Hello' });
			} finally {
				context.dispose();
			}
		} finally {
			Object.defineProperty(globalThis, 'process', descriptor);
		}
	});
});
