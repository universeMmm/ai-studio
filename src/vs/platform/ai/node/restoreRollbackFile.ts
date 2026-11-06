/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Restore a captured file without overwriting a concurrent edit.
 *--------------------------------------------------------------------------------------------*/

import { link, copyFile, constants } from 'fs/promises';
import { basename, dirname, isAbsolute } from '../../../base/common/path.js';

export async function restoreRollbackFile(recovery: string, target: string): Promise<void> {
	if (!isAbsolute(target) || dirname(recovery) !== dirname(target) || !/^\.ai-studio-rollback-[\da-f-]{36}$/i.test(basename(recovery))) {
		throw new Error('Invalid rollback file');
	}
	try {
		// link is an atomic no-overwrite operation, unlike checking existence
		// before rename. It also preserves the captured file's permissions.
		await link(recovery, target);
	} catch (err) {
		if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) { throw err; }
		// FAT and some network shares do not support hard links.
		await copyFile(recovery, target, constants.COPYFILE_EXCL);
	}
}
