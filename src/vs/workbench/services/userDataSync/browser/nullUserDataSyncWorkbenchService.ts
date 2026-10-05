/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUserDataSyncResource } from '../../../../platform/userDataSync/common/userDataSync.js';
import { AccountStatus, IUserDataSyncWorkbenchService } from '../common/userDataSync.js';

/**
 * Workbench-facing Settings Sync service. Sync is disabled, so account and
 * conflict operations are no-ops.
 */
export class NullUserDataSyncWorkbenchService implements IUserDataSyncWorkbenchService {
	declare readonly _serviceBrand: undefined;

	readonly enabled = false;
	readonly authenticationProviders = [];
	readonly current = undefined;
	readonly accountStatus = AccountStatus.Unavailable;
	readonly onDidChangeAccountStatus = Event.None;
	readonly onDidTurnOnSync = Event.None;

	async turnOn(): Promise<void> { }
	async turnoff(_everyWhere: boolean): Promise<void> { }
	async signIn(): Promise<void> { }
	async resetSyncedData(): Promise<void> { }
	async showSyncActivity(): Promise<void> { }
	async syncNow(): Promise<void> { }
	async synchroniseUserDataSyncStoreType(): Promise<void> { }
	async showConflicts(): Promise<void> { }
	async accept(_resource: IUserDataSyncResource, _conflictResource: URI, _content: string | null | undefined, _apply: boolean): Promise<void> { }
	async getAllLogResources(): Promise<URI[]> { return []; }
	async downloadSyncActivity(): Promise<URI | undefined> { return undefined; }
}

registerSingleton(IUserDataSyncWorkbenchService, NullUserDataSyncWorkbenchService, InstantiationType.Delayed);
