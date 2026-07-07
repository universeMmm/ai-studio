/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { IHeaders } from '../../../base/parts/request/common/request.js';
import { VSBufferReadableStream } from '../../../base/common/buffer.js';
import { ILocalExtension } from '../../extensionManagement/common/extensionManagement.js';
import { NullLogService } from '../../log/common/log.js';
import { IUserDataSyncMachine } from './userDataSyncMachines.js';
import { IUserDataSyncAccount, IUserDataSyncAccountService } from './userDataSyncAccount.js';
import { IIgnoredExtensionsManagementService } from './ignoredExtensions.js';
import {
	IUserDataSyncService,
	IUserDataAutoSyncService,
	IUserDataSyncEnablementService,
	IUserDataSyncStoreService,
	IUserDataSyncLocalStoreService,
	IUserDataSyncResourceProviderService,
	IUserDataSyncLogService,
	SyncResource,
	SyncStatus,
	IUserDataSyncResourceConflicts,
	IUserDataSyncResourceError,
	IUserDataSyncTask,
	IUserDataManualSyncTask,
	IUserDataSyncResource,
	ISyncResourceHandle,
	UserDataSyncError,
	IUserDataManifest,
	IUserData,
	ServerResource,
	IResourceRefHandle,
	ISyncUserDataProfile,
	IUserDataSyncLatestData,
} from './userDataSync.js';

// Re-export so consumers can import everything from one file
export {
	SyncResource,
	SyncStatus,
	UserDataSyncError,
};

// ---------------------------------------------------------------------------
// IUserDataSyncEnablementService — sync is always disabled
// ---------------------------------------------------------------------------

export class NullUserDataSyncEnablementService implements IUserDataSyncEnablementService {

	declare _serviceBrand: undefined;

	readonly onDidChangeEnablement: Event<boolean> = Event.None;

	isEnabled(): boolean { return false; }
	canToggleEnablement(): boolean { return false; }
	setEnablement(_enabled: boolean): void { }

	readonly onDidChangeResourceEnablement: Event<[SyncResource, boolean]> = Event.None;
	isResourceEnabled(_resource: SyncResource, _defaultValue?: boolean): boolean { return false; }
	setResourceEnablement(_resource: SyncResource, _enabled: boolean): void { }
	getResourceSyncStateVersion(_resource: SyncResource): string | undefined { return undefined; }
	isResourceEnablementConfigured(_resource: SyncResource): boolean { return false; }
}

// ---------------------------------------------------------------------------
// IUserDataSyncService — all sync operations are no-ops
// ---------------------------------------------------------------------------

export class NullUserDataSyncService implements IUserDataSyncService {

	declare _serviceBrand: undefined;

	readonly status: SyncStatus = SyncStatus.Idle;
	readonly onDidChangeStatus: Event<SyncStatus> = Event.None;

	readonly conflicts: IUserDataSyncResourceConflicts[] = [];
	readonly onDidChangeConflicts: Event<IUserDataSyncResourceConflicts[]> = Event.None;

	readonly onDidChangeLocal: Event<SyncResource> = Event.None;
	readonly onSyncErrors: Event<IUserDataSyncResourceError[]> = Event.None;

	readonly lastSyncTime: number | undefined = undefined;
	readonly onDidChangeLastSyncTime: Event<number> = Event.None;

	readonly onDidResetRemote: Event<void> = Event.None;
	readonly onDidResetLocal: Event<void> = Event.None;

	async createSyncTask(_manifest: IUserDataManifest | null | any, _disableCache?: boolean): Promise<IUserDataSyncTask> {
		return { manifest: null, run: async () => { }, stop: async () => { } };
	}

	async createManualSyncTask(): Promise<IUserDataManualSyncTask> {
		return { id: 'null', merge: async () => { }, apply: async () => { }, stop: async () => { } };
	}

	async resolveContent(_resource: URI): Promise<string | null> { return null; }
	async accept(_syncResource: IUserDataSyncResource, _resource: URI, _content: string | null | undefined, _apply: boolean | { force: boolean }): Promise<void> { }
	async reset(): Promise<void> { }
	async resetRemote(): Promise<void> { }
	async cleanUpRemoteData(): Promise<void> { }
	async resetLocal(): Promise<void> { }
	async hasLocalData(): Promise<boolean> { return false; }
	async hasPreviouslySynced(): Promise<boolean> { return false; }
	async replace(_syncResourceHandle: ISyncResourceHandle): Promise<void> { }
	async saveRemoteActivityData(_location: URI): Promise<void> { }
	async extractActivityData(_activityDataResource: URI, _location: URI): Promise<void> { }
}

// ---------------------------------------------------------------------------
// IUserDataAutoSyncService — auto-sync is always off
// ---------------------------------------------------------------------------

export class NullUserDataAutoSyncService implements IUserDataAutoSyncService {

	declare _serviceBrand: undefined;

	readonly onError: Event<UserDataSyncError> = Event.None;

	async turnOn(): Promise<void> { }
	async turnOff(_everywhere: boolean): Promise<void> { }
	async triggerSync(_sources: string[], _options?: any): Promise<void> { }
}

// ---------------------------------------------------------------------------
// IUserDataSyncStoreService — no remote store
// ---------------------------------------------------------------------------

export class NullUserDataSyncStoreService implements IUserDataSyncStoreService {

	declare _serviceBrand: undefined;

	readonly onDidChangeDonotMakeRequestsUntil: Event<void> = Event.None;
	readonly donotMakeRequestsUntil: Date | undefined = undefined;

	readonly onTokenFailed: Event<any> = Event.None;
	readonly onTokenSucceed: Event<void> = Event.None;
	setAuthToken(_token: string, _type: string): void { }

	async manifest(_oldValue: IUserDataManifest | null, _headers?: IHeaders): Promise<IUserDataManifest | null> { return null; }
	async readResource(_resource: ServerResource, _oldValue: IUserData | null, _collection?: string, _headers?: IHeaders): Promise<IUserData> { return { ref: 'null', content: null }; }
	async writeResource(_resource: ServerResource, _content: string, _ref: string | null, _collection?: string, _headers?: IHeaders): Promise<string> { return 'null'; }
	async deleteResource(_resource: ServerResource, _ref: string | null, _collection?: string): Promise<void> { }
	async getAllResourceRefs(_resource: ServerResource, _collection?: string): Promise<IResourceRefHandle[]> { return []; }
	async resolveResourceContent(_resource: ServerResource, _ref: string, _collection?: string, _headers?: IHeaders): Promise<string | null> { return null; }
	async getAllCollections(_headers?: IHeaders): Promise<string[]> { return []; }
	async createCollection(_headers?: IHeaders): Promise<string> { return 'null'; }
	async deleteCollection(_collection?: string, _headers?: IHeaders): Promise<void> { }
	async getLatestData(_headers?: IHeaders): Promise<IUserDataSyncLatestData | null> { return null; }
	async getActivityData(): Promise<VSBufferReadableStream> { throw new Error('Not available'); }
	async clear(): Promise<void> { }
}

// ---------------------------------------------------------------------------
// IUserDataSyncLocalStoreService — no local sync data
// ---------------------------------------------------------------------------

export class NullUserDataSyncLocalStoreService implements IUserDataSyncLocalStoreService {

	declare _serviceBrand: undefined;

	async writeResource(_resource: ServerResource, _content: string, _cTime: Date, _collection?: string, _root?: URI): Promise<void> { }
	async getAllResourceRefs(_resource: ServerResource, _collection?: string, _root?: URI): Promise<IResourceRefHandle[]> { return []; }
	async resolveResourceContent(_resource: ServerResource, _ref: string, _collection?: string, _root?: URI): Promise<string | null> { return null; }
}

// ---------------------------------------------------------------------------
// IUserDataSyncResourceProviderService — no resources to provide
// ---------------------------------------------------------------------------

export class NullUserDataSyncResourceProviderService implements IUserDataSyncResourceProviderService {

	declare _serviceBrand: undefined;

	async getRemoteSyncedProfiles(): Promise<ISyncUserDataProfile[]> { return []; }
	async getLocalSyncedProfiles(_location?: URI): Promise<ISyncUserDataProfile[]> { return []; }
	async getRemoteSyncResourceHandles(_syncResource: SyncResource, _profile?: ISyncUserDataProfile): Promise<ISyncResourceHandle[]> { return []; }
	async getLocalSyncResourceHandles(_syncResource: SyncResource, _profile?: ISyncUserDataProfile, _location?: URI): Promise<ISyncResourceHandle[]> { return []; }
	async getAssociatedResources(_syncResourceHandle: ISyncResourceHandle): Promise<{ resource: URI; comparableResource: URI }[]> { return []; }
	async getMachineId(_syncResourceHandle: ISyncResourceHandle): Promise<string | undefined> { return undefined; }
	async getLocalSyncedMachines(_location?: URI): Promise<IUserDataSyncMachine[]> { return []; }
	async resolveContent(_resource: URI): Promise<string | null> { return null; }
	resolveUserDataSyncResource(_syncResourceHandle: ISyncResourceHandle): IUserDataSyncResource | undefined { return undefined; }
}

// ---------------------------------------------------------------------------
// IUserDataSyncAccountService — no account
// ---------------------------------------------------------------------------

export class NullUserDataSyncAccountService implements IUserDataSyncAccountService {

	declare _serviceBrand: undefined;

	readonly onTokenFailed: Event<boolean> = Event.None;
	readonly account: IUserDataSyncAccount | undefined = undefined;
	readonly onDidChangeAccount: Event<IUserDataSyncAccount | undefined> = Event.None;

	async updateAccount(_account: IUserDataSyncAccount | undefined): Promise<void> { }
}

// ---------------------------------------------------------------------------
// IUserDataSyncLogService — no sync logging
// ---------------------------------------------------------------------------

export class NullUserDataSyncLogService extends NullLogService implements IUserDataSyncLogService {
	declare _serviceBrand: undefined;
}

// ---------------------------------------------------------------------------
// IIgnoredExtensionsManagementService — no extensions to ignore
// ---------------------------------------------------------------------------

export class NullIgnoredExtensionsManagementService implements IIgnoredExtensionsManagementService {

	declare _serviceBrand: undefined;

	getIgnoredExtensions(_installed: ILocalExtension[]): string[] { return []; }
	hasToNeverSyncExtension(_extensionId: string): boolean { return false; }
	hasToAlwaysSyncExtension(_extensionId: string): boolean { return false; }
	async updateIgnoredExtensions(_ignoredExtensionId: string, _ignore: boolean): Promise<void> { }
	async updateSynchronizedExtensions(_ignoredExtensionId: string, _sync: boolean): Promise<void> { }
}
