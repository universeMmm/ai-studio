/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileContent, IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DiffApplyController } from '../../browser/diffApplyController.js';
import { IDiffStore } from '../../browser/diffStore.js';
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
		const fileService = upcastPartial<IFileService>({
			async readFile(_resource: URI) {
				return upcastPartial<IFileContent>({ value: VSBuffer.fromString('modified\nkeep\nmodified\nend\n') });
			},
			async writeFile(_resource: URI, content: VSBuffer) {
				written = content.toString();
				return upcastPartial<IFileStatWithMetadata>({});
			},
		});
		const diffStore = upcastPartial<IDiffStore>({
			groups,
			rejectHunk(_groupId: string, _hunkId: string) {
				hunk.status = 'rejected';
			},
		});
		const textFiles = upcastPartial<ITextFileService>({ isDirty: () => false });
		const workspace = upcastPartial<IWorkspaceContextService>({ isInsideWorkspace: () => true });
		const controller = new DiffApplyController(diffStore, textFiles, fileService, workspace);

		await controller.rejectHunk('group_1', 'hunk_1');

		assert.strictEqual(written, 'modified\nkeep\noriginal\nend\n');
		controller.dispose();
	});
});
