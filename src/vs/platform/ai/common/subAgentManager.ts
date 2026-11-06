/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { SubAgentConfig, SubAgentResult } from './aiTypes.js';
import type { CommandApprovalHandler } from './toolRuntime.js';

export const ISubAgentManager = createDecorator<ISubAgentManager>('subAgentManager');

export interface SubAgentExecutionContext {
	signal?: AbortSignal;
	approve?: CommandApprovalHandler;
	sessionId?: string;
	requestId?: string;
}

export interface ISubAgentManager {
	readonly _serviceBrand: undefined;
	execute(configs: SubAgentConfig[], context?: SubAgentExecutionContext): Promise<SubAgentResult[]>;
	sendMessage(from: string, to: string, summary: string, message: string | object): void;
	getRunningAgents(): string[];
}
