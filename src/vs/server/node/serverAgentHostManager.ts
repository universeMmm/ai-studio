/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { ILogService, ILoggerService } from '../../platform/log/common/log.js';
import { IServerLifetimeService } from './serverLifetimeService.js';

export const IServerAgentHostManager = createDecorator<IServerAgentHostManager>('serverAgentHostManager');

/**
 * Agent host 管理器已被移除（agentHost 模块不参与编译）。
 * 此文件仅保留空的接口和占位实现，供 DI 容器注册使用。
 */
export interface IServerAgentHostManager {
	readonly _serviceBrand: undefined;
}

export class ServerAgentHostManager extends Disposable implements IServerAgentHostManager {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService _logService: ILogService,
		@ILoggerService _loggerService: ILoggerService,
		@IServerLifetimeService _serverLifetimeService: IServerLifetimeService,
	) {
		super();
		// agentHost 已剥离，不做任何操作
	}
}
