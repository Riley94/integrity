/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IResourceRefHandle, IUserData } from '../../../../platform/userDataSync/common/userDataSync.js';

/**
 * Continue-on edit sessions no longer talk to the Settings Sync store.
 * Reads return nothing and writes are ignored.
 */
export class EditSessionsStoreClient {
	readonly onTokenFailed = Event.None;

	constructor(..._args: unknown[]) { }

	setAuthToken(..._args: unknown[]): void { }

	async writeResource(..._args: unknown[]): Promise<string> { return ''; }

	async readResource(..._args: unknown[]): Promise<IUserData> { return { ref: '', content: null }; }

	async resolveResourceContent(..._args: unknown[]): Promise<string | null> { return null; }

	async deleteResource(..._args: unknown[]): Promise<void> { }

	async getAllResourceRefs(..._args: unknown[]): Promise<IResourceRefHandle[]> { return []; }
}
