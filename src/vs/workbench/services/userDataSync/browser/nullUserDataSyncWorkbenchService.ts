/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IAuthenticationProvider } from '../../../../platform/userDataSync/common/userDataSync.js';
import { IUserDataSyncAccount, IUserDataSyncWorkbenchService, AccountStatus } from '../common/userDataSync.js';
import { IResourcePreview, IUserDataSyncResource } from '../../../../platform/userDataSync/common/userDataSync.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export class NullUserDataSyncWorkbenchService implements IUserDataSyncWorkbenchService {

	declare readonly _serviceBrand: undefined;

	readonly enabled = false;
	readonly authenticationProviders: IAuthenticationProvider[] = [];

	readonly current: IUserDataSyncAccount | undefined = undefined;

	readonly accountStatus: AccountStatus = AccountStatus.Unavailable;
	readonly onDidChangeAccountStatus: Event<AccountStatus> = Event.None;

	readonly onDidTurnOnSync: Event<void> = Event.None;

	async turnOn(): Promise<void> { }
	async turnoff(_everyWhere: boolean): Promise<void> { }
	async signIn(): Promise<void> { }
	async resetSyncedData(): Promise<void> { }
	async showSyncActivity(): Promise<void> { }
	async syncNow(): Promise<void> { }
	async synchroniseUserDataSyncStoreType(): Promise<void> { }
	async showConflicts(_conflictToOpen?: IResourcePreview): Promise<void> { }
	async accept(_resource: IUserDataSyncResource, _conflictResource: URI, _content: string | null | undefined, _apply: boolean): Promise<void> { }
	async getAllLogResources(): Promise<URI[]> { return []; }
	async downloadSyncActivity(): Promise<URI | undefined> { return undefined; }
}

// Register as the singleton — this replaces the real UserDataSyncWorkbenchService
registerSingleton(IUserDataSyncWorkbenchService, NullUserDataSyncWorkbenchService, InstantiationType.Delayed);
