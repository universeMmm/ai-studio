/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Exercise review from a real tool write through workspace persistence.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { VSBuffer } from '../../../src/vs/base/common/buffer.js';
import { URI } from '../../../src/vs/base/common/uri.js';
import { upcastDeepPartial, upcastPartial } from '../../../src/vs/base/test/common/mock.js';
import { ToolExecutor } from '../../../src/vs/platform/ai/browser/toolExecutor.js';
import { FileService } from '../../../src/vs/platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../src/vs/platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../src/vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../src/vs/platform/workspace/common/workspace.js';
import { DiffApplyController } from '../../../src/vs/workbench/contrib/aiDiffApply/browser/diffApplyController.js';
import { DiffStore } from '../../../src/vs/workbench/contrib/aiDiffApply/browser/diffStore.js';

suite('Agent workspace edit review', () => {
	const root = URI.file('/project');
	const target = URI.joinPath(root, 'example.ts');
	const log = new NullLogService();
	const workspace = upcastDeepPartial<IWorkspaceContextService>({
		getWorkspace: () => ({ folders: [{ uri: root }] }),
		isInsideWorkspace: (uri: URI) => uri.path.startsWith('/project/'),
	});
	let files: FileService;
	let disk: InMemoryFileSystemProvider;
	let store: DiffStore;
	let review: DiffApplyController;
	let tool: ToolExecutor;
	let dirty: boolean;

	setup(async () => {
		dirty = false;
		files = new FileService(log);
		disk = new InMemoryFileSystemProvider();
		files.registerProvider('file', disk);
		store = new DiffStore(files, log);
		await store.initialize(root.fsPath);
		review = new DiffApplyController(store, upcastPartial({ isDirty: () => dirty }), files, workspace);
		tool = new ToolExecutor(files, log, store, upcastPartial({}), upcastPartial({}), workspace, upcastPartial({ getValue: () => undefined }),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { sessionId: 'chat-A', requestId: 'turn-A' });
	});
	teardown(async () => { await store.whenSaved(); review.dispose(); store.dispose(); files.dispose(); disk.dispose(); });

	test('keeps an edit without rewriting it and restores its conversation association on restart', async () => {
		await tool.execute('write_file', { path: target.fsPath, content: 'keep me' });
		const [group] = store.groups;
		await review.acceptHunk(group.id, group.hunks[0].id);
		await store.whenSaved();
		const restored = new DiffStore(files, log);
		try {
			await restored.initialize(root.fsPath);
			assert.equal(restored.groups[0].sessionId, 'chat-A');
			assert.equal(restored.groups[0].chatMessageId, 'turn-A');
			assert.equal(restored.groups[0].hunks[0].status, 'accepted');
			assert.equal(restored.getAllAppliedHunks().length, 0);
			assert.equal((await files.readFile(target)).value.toString(), 'keep me');
		} finally { restored.dispose(); }
	});

	test('undo preserves the surrounding line, including its terminator', async () => {
		const original = 'prefix old suffix\r\nnext\r\n';
		await files.createFile(target, VSBuffer.fromString(original));
		await tool.execute('edit_file', { path: target.fsPath, old_string: 'old', new_string: 'new' });
		const [group] = store.groups;
		assert.equal(group.hunks[0].modifiedStartColumn, 8);
		await review.rejectHunk(group.id, group.hunks[0].id);
		assert.equal((await files.readFile(target)).value.toString(), original);
	});

	test('saves pending decisions to the originating workspace when switching folders', async () => {
		await tool.execute('write_file', { path: target.fsPath, content: 'agent' });
		const [group] = store.groups;
		store.acceptHunk(group.id, group.hunks[0].id);
		await store.initialize('/another-project');
		assert.equal(store.groups.length, 0);
		await store.initialize(root.fsPath);
		assert.equal(store.groups[0].hunks[0].status, 'accepted');
	});

	test('replace-all is fully reverted as one file edit', async () => {
		const original = 'one old\ntwo old\nthree old';
		await files.createFile(target, VSBuffer.fromString(original));
		await tool.execute('edit_file', { path: target.fsPath, old_string: 'old', new_string: 'new', replace_all: true });
		const [group] = store.groups;
		await review.rejectAll(group.id);
		assert.equal((await files.readFile(target)).value.toString(), original);
	});

	test('refuses a changed or unsaved file while leaving review pending', async () => {
		await tool.execute('write_file', { path: target.fsPath, content: 'agent' });
		const [group] = store.groups;
		dirty = true;
		await assert.rejects(review.rejectAll(group.id), /保存/);
		dirty = false;
		await files.writeFile(target, VSBuffer.fromString('human'));
		await assert.rejects(review.rejectAll(group.id), /变化/);
		assert.equal((await files.readFile(target)).value.toString(), 'human');
		assert.equal(group.hunks[0].status, 'applied');
	});

	test('undoing an agent-created file removes the file and leaves no empty substitute', async () => {
		await tool.execute('write_file', { path: target.fsPath, content: 'agent' });
		const [group] = store.groups;
		await review.rejectAll(group.id);
		assert.equal(await files.exists(target), false);
		assert.equal(group.hunks[0].status, 'rejected');
	});
});
