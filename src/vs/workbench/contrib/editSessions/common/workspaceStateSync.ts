/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workspace-state sync used the Settings Sync store. That store is gone, so
 * continue-on keeps the call sites and does not upload or apply remote state.
 */
export class WorkspaceStateSynchroniser {
	constructor(..._args: unknown[]) { }

	async sync(): Promise<void> { }

	async apply(): Promise<void> { }
}
