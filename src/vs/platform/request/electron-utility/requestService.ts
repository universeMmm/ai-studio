/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IRawRequestFunction, nodeRequest, RequestService as NodeRequestService } from '../node/requestService.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';

function getRawRequest(options: IRequestOptions): IRawRequestFunction {
	// eslint-disable-next-line local/code-no-any-casts
	return net.request as any as IRawRequestFunction;
}

export class RequestService extends NodeRequestService {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super('desktop', configurationService, environmentService, logService);
	}

	override request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		// Chromium resolves the system proxy and handles authentication for this request.
		return this.logAndRequest(options, () => nodeRequest({ ...options, getRawRequest, isChromiumNetwork: true }, token));
	}
}
