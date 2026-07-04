/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';

// agentHost 剥离：本地桩代码替换原 agentHost 模块引用
// 无 agentHost 时，resolveRemoteAuthority 始终返回 undefined

/**
 * Resolves the VS Code remote authority for the given session provider.
 * agentHost 剥离后始终返回 undefined。
 */
export function resolveRemoteAuthority(
	_providerId: string,
	_sessionsProvidersService: ISessionsProvidersService,
	_remoteAgentHostService: unknown,
): string | undefined {
	return undefined;
}
