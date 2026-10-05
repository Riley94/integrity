/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBufferReadableStream } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { emptyStream } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IUserDataSyncAccount, IUserDataSyncAccountService } from './userDataSyncAccount.js';
import { IUserDataSyncMachine, IUserDataSyncMachinesService } from './userDataSyncMachines.js';
import { ISyncResourceHandle, ISyncUserDataProfile, IUserData, IUserDataAutoSyncService, IUserDataManifest, IUserDataSyncEnablementService, IUserDataSyncLocalStoreService, IUserDataSyncResource, IUserDataSyncResourceConflicts, IUserDataSyncResourceError, IUserDataSyncResourceProviderService, IUserDataSyncService, IUserDataSyncStoreManagementService, IUserDataSyncStoreService, SyncResource, SyncStatus, UserDataSyncStoreType } from './userDataSync.js';

/**
 * Settings Sync is not part of this product. These services satisfy the
 * existing injection sites and report sync as disabled.
 */
export class NullUserDataSyncStoreManagementService implements IUserDataSyncStoreManagementService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeUserDataSyncStore = Event.None;
	readonly userDataSyncStore = undefined;
	async switch(_type: UserDataSyncStoreType): Promise<void> { }
	async getPreviousUserDataSyncStore(): Promise<undefined> { return undefined; }
}

export class NullUserDataSyncStoreService implements IUserDataSyncStoreService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeDonotMakeRequestsUntil = Event.None;
	readonly donotMakeRequestsUntil = undefined;
	readonly onTokenFailed = Event.None;
	readonly onTokenSucceed = Event.None;
	setAuthToken(_token: string, _type: string): void { }
	async manifest(_oldValue: IUserDataManifest | null): Promise<IUserDataManifest | null> { return null; }
	async readResource(): Promise<IUserData> { return { ref: '', content: null }; }
	async writeResource(): Promise<string> { return ''; }
	async deleteResource(): Promise<void> { }
	async getAllResourceRefs(): Promise<[]> { return []; }
	async resolveResourceContent(): Promise<string | null> { return null; }
	async getAllCollections(): Promise<string[]> { return []; }
	async createCollection(): Promise<string> { return ''; }
	async deleteCollection(): Promise<void> { }
	async getLatestData(): Promise<null> { return null; }
	async getActivityData(): Promise<VSBufferReadableStream> { return emptyStream() as unknown as VSBufferReadableStream; }
	async clear(): Promise<void> { }
}

export class NullUserDataSyncLocalStoreService implements IUserDataSyncLocalStoreService {
	declare readonly _serviceBrand: undefined;
	async writeResource(): Promise<void> { }
	async getAllResourceRefs(): Promise<[]> { return []; }
	async resolveResourceContent(): Promise<string | null> { return null; }
}

export class NullUserDataSyncEnablementService implements IUserDataSyncEnablementService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEnablement = Event.None;
	readonly onDidChangeResourceEnablement = Event.None;
	isEnabled(): boolean { return false; }
	canToggleEnablement(): boolean { return false; }
	setEnablement(_enabled: boolean): void { }
	isResourceEnabled(_resource: SyncResource, _defaultValue?: boolean): boolean { return false; }
	setResourceEnablement(_resource: SyncResource, _enabled: boolean): void { }
	getResourceSyncStateVersion(_resource: SyncResource): string | undefined { return undefined; }
	isResourceEnablementConfigured(_resource: SyncResource): boolean { return false; }
}

export class NullUserDataSyncService implements IUserDataSyncService {
	declare readonly _serviceBrand: undefined;
	readonly status = SyncStatus.Uninitialized;
	readonly onDidChangeStatus = Event.None;
	readonly conflicts: IUserDataSyncResourceConflicts[] = [];
	readonly onDidChangeConflicts = Event.None;
	readonly onDidChangeLocal: Event<SyncResource> = Event.None;
	readonly onSyncErrors: Event<IUserDataSyncResourceError[]> = Event.None;
	readonly lastSyncTime = undefined;
	readonly onDidChangeLastSyncTime = Event.None;
	readonly onDidResetRemote = Event.None;
	readonly onDidResetLocal = Event.None;
	async createSyncTask(): Promise<{ manifest: null; run(): Promise<void>; stop(): Promise<void> }> {
		return { manifest: null, run: async () => { }, stop: async () => { } };
	}
	async createManualSyncTask(): Promise<{ id: string; merge(): Promise<void>; apply(): Promise<void>; stop(): Promise<void> }> {
		return { id: '', merge: async () => { }, apply: async () => { }, stop: async () => { } };
	}
	async resolveContent(_resource: URI): Promise<string | null> { return null; }
	async accept(_syncResource: IUserDataSyncResource, _resource: URI, _content: string | null | undefined, _apply: boolean | { force: boolean }): Promise<void> { }
	async reset(): Promise<void> { }
	async resetRemote(): Promise<void> { }
	async cleanUpRemoteData(): Promise<void> { }
	async resetLocal(): Promise<void> { }
	async hasLocalData(): Promise<boolean> { return false; }
	async hasPreviouslySynced(): Promise<boolean> { return false; }
	async replace(): Promise<void> { }
	async saveRemoteActivityData(_location: URI): Promise<void> { }
	async extractActivityData(_activityDataResource: URI, _location: URI): Promise<void> { }
}

export class NullUserDataSyncResourceProviderService implements IUserDataSyncResourceProviderService {
	declare readonly _serviceBrand: undefined;
	async getRemoteSyncedProfiles(): Promise<ISyncUserDataProfile[]> { return []; }
	async getLocalSyncedProfiles(): Promise<ISyncUserDataProfile[]> { return []; }
	async getRemoteSyncResourceHandles(): Promise<ISyncResourceHandle[]> { return []; }
	async getLocalSyncResourceHandles(): Promise<ISyncResourceHandle[]> { return []; }
	async getAssociatedResources(): Promise<{ resource: URI; comparableResource: URI }[]> { return []; }
	async getMachineId(): Promise<string | undefined> { return undefined; }
	async getLocalSyncedMachines(): Promise<IUserDataSyncMachine[]> { return []; }
	async resolveContent(_resource: URI): Promise<string | null> { return null; }
	resolveUserDataSyncResource(): undefined { return undefined; }
}

export class NullUserDataAutoSyncService extends Disposable implements IUserDataAutoSyncService {
	declare readonly _serviceBrand: undefined;
	readonly onError = Event.None;
	async turnOn(): Promise<void> { }
	async turnOff(_everywhere: boolean): Promise<void> { }
	async triggerSync(_sources: string[]): Promise<void> { }
}

export class NullUserDataSyncAccountService implements IUserDataSyncAccountService {
	declare readonly _serviceBrand: undefined;
	readonly onTokenFailed = Event.None;
	readonly account: IUserDataSyncAccount | undefined = undefined;
	readonly onDidChangeAccount = Event.None;
	async updateAccount(_account: IUserDataSyncAccount | undefined): Promise<void> { }
}

export class NullUserDataSyncMachinesService implements IUserDataSyncMachinesService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	async getMachines(): Promise<IUserDataSyncMachine[]> { return []; }
	async addCurrentMachine(): Promise<void> { }
	async removeCurrentMachine(): Promise<void> { }
	async renameMachine(_machineId: string, _name: string): Promise<void> { }
	async setEnablements(_enablements: [string, boolean][]): Promise<void> { }
}

registerSingleton(IUserDataSyncStoreManagementService, NullUserDataSyncStoreManagementService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncStoreService, NullUserDataSyncStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncLocalStoreService, NullUserDataSyncLocalStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncEnablementService, NullUserDataSyncEnablementService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncService, NullUserDataSyncService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncResourceProviderService, NullUserDataSyncResourceProviderService, InstantiationType.Delayed);
registerSingleton(IUserDataAutoSyncService, NullUserDataAutoSyncService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncAccountService, NullUserDataSyncAccountService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncMachinesService, NullUserDataSyncMachinesService, InstantiationType.Delayed);
