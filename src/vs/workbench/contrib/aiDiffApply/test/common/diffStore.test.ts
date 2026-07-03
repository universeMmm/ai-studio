/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { DiffStore } from '../../browser/diffStore.js';
import type { DiffGroup } from '../../common/diffTypes.js';

suite('DiffStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persists hunk rejection state', async () => {
		const files = new Map<string, string>();
		const writes: string[] = [];
		const fileService = {
			async readFile(resource: URI) {
				const value = files.get(resource.fsPath);
				if (typeof value !== 'string') {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(value) };
			},
			async writeFile(resource: URI, content: VSBuffer) {
				const text = content.toString();
				files.set(resource.fsPath, text);
				writes.push(text);
				return {};
			},
		};
		const store = new DiffStore(fileService as any, new NullLogService());
		await store.initialize('C:/workspace');

		const group: DiffGroup = {
			id: 'group_1',
			chatMessageId: '',
			createdAt: 1,
			hunks: [{
				id: 'hunk_1',
				filePath: 'src/file.ts',
				originalStartLine: 1,
				originalEndLine: 1,
				modifiedStartLine: 1,
				modifiedEndLine: 1,
				originalText: 'old',
				modifiedText: 'new',
				status: 'applied',
			}],
		};

		store.addGroup(group);
		store.rejectHunk('group_1', 'hunk_1');
		await Promise.resolve();

		const persisted = JSON.parse(writes[writes.length - 1]);
		assert.strictEqual(persisted.groups[0].hunks[0].status, 'rejected');
		store.dispose();
	});
});
