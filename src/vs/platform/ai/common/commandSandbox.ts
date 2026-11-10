/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OperatingSystem } from '../../../base/common/platform.js';
import type { ISandboxDependencyStatus, IWindowsMxcFilesystemPolicy } from '../../sandbox/common/sandboxHelperService.js';

export interface AICommandSandboxContext {
	appRoot: string;
	execPath: string;
	userHome: string;
	tempDir: string;
	shell: string;
	os: OperatingSystem;
	arch: string;
	dependencies?: ISandboxDependencyStatus;
	windowsPolicy?: IWindowsMxcFilesystemPolicy;
	windowsEnvironment?: string[];
}
