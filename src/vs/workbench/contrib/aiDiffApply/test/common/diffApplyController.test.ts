/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DiffApplyController } from '../../browser/diffApplyController.js';
import type { DiffGroup, DiffHunk } from '../../common/diffTypes.js';

suite('DiffApplyController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejectHunk reverts the hunk at its modified line range when text repeats', async () => {
		const filePath = 'C:/workspace/file.txt';
		const hunk: DiffHunk = {
			id: 'hunk_1',
			filePath,
			originalStartLine: 3,
			originalEndLine: 3,
			modifiedStartLine: 3,
			modifiedEndLine: 3,
			originalText: 'original\n',
			modifiedText: 'modified\n',
			status: 'applied',
		};
		const groups: DiffGroup[] = [{
			id: 'group_1',
			chatMessageId: '',
			createdAt: 1,
			hunks: [hunk],
		}];
		let written = '';
		const fileService = {
			async readFile(_resource: URI) {
				return { value: VSBuffer.fromString('modified\nkeep\nmodified\nend\n') };
			},
			async writeFile(_resource: URI, content: VSBuffer) {
				written = content.toString();
				return {};
			},
		};
		const diffStore = {
			groups,
			rejectHunk(_groupId: string, _hunkId: string) {
				hunk.status = 'rejected';
			},
		};
		const editorService = { visibleTextEditorControls: [] };
		const controller = new DiffApplyController(diffStore as any, editorService as any, fileService as any);

		await controller.rejectHunk('group_1', 'hunk_1');

		assert.strictEqual(written, 'modified\nkeep\noriginal\nend\n');
		controller.dispose();
	});
});
