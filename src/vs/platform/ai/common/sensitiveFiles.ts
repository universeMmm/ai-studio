/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match as globMatches } from '../../../base/common/glob.js';

export const SENSITIVE_FILE_GLOBS = ['.git', '.env', '.env.*', '*.pem', '*.key', '*credentials*', '*secret*', '.npmrc', '*id_rsa*', '*.pfx', '*.p12'];

export function isSensitiveFile(filePath: string): boolean {
	return filePath.split(/[\\/]/).some(part => SENSITIVE_FILE_GLOBS.some(pattern => globMatches(pattern, part.toLowerCase())));
}
