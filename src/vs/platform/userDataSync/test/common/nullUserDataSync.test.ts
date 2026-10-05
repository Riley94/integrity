/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullUserDataSyncEnablementService, NullUserDataSyncService, NullUserDataSyncStoreManagementService } from '../../common/nullUserDataSync.js';
import { SyncStatus } from '../../common/userDataSync.js';

suite('NullUserDataSync', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports settings sync as disabled', async () => {
		const enablement = new NullUserDataSyncEnablementService();
		const store = new NullUserDataSyncStoreManagementService();
		const sync = new NullUserDataSyncService();

		assert.strictEqual(enablement.isEnabled(), false);
		assert.strictEqual(enablement.canToggleEnablement(), false);
		assert.strictEqual(store.userDataSyncStore, undefined);
		assert.strictEqual(sync.status, SyncStatus.Uninitialized);
		assert.deepStrictEqual(sync.conflicts, []);
		assert.strictEqual(await sync.hasLocalData(), false);
		assert.strictEqual(await sync.hasPreviouslySynced(), false);
	});
});
