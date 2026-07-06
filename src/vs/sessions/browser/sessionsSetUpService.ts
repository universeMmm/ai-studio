/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { DeferredPromise } from '../../base/common/async.js';
import { createDecorator, IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IUserDataProfileStorageService } from '../../platform/userDataProfile/common/userDataProfileStorageService.js';
import { IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { IChatEntitlementService } from '../../workbench/services/chat/common/chatEntitlementService.js';

export const ISessionsSetUpService = createDecorator<ISessionsSetUpService>('sessionsSetUpService');

export interface ISessionsSetUpService {
	readonly _serviceBrand: undefined;
	/**
	 * Resolves when the welcome/setup flow has completed (or immediately
	 * if it is not currently active). Use this to defer work until after
	 * the user has finished the initial sign-in or setup dialog.
	 */
	whenWelcomeDone(): Promise<void>;
}

// AI Studio: SessionsSetUpService simplified — no authentication, welcome resolves immediately.
// The SessionsSetUpWidget (welcome/sign-in dialogs) has been removed since AI Studio
// has no account/auth system.

export class SessionsSetUpService extends Disposable implements ISessionsSetUpService {

	declare readonly _serviceBrand: undefined;

	private readonly _welcomeDoneDeferred = new DeferredPromise<void>();

	constructor(
		@IInstantiationService _instantiationService: IInstantiationService,
		@IUserDataProfileStorageService _userDataProfileStorageService: IUserDataProfileStorageService,
		@IUserDataProfilesService _userDataProfilesService: IUserDataProfilesService,
		@IChatEntitlementService _chatEntitlementService: IChatEntitlementService,
		@ILogService _logService: ILogService,
	) {
		super();
		// AI Studio: no auth — welcome is always done
		this._welcomeDoneDeferred.complete();
	}

	whenWelcomeDone(): Promise<void> {
		return this._welcomeDoneDeferred.p;
	}
}
