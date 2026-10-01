/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEditThenSave } from '../editPersistence';

describe('applyEditThenSave', () => {
	it('saves after the edit is accepted', async () => {
		const order: string[] = [];
		const ok = await applyEditThenSave(
			async () => {
				order.push('apply');
				return true;
			},
			async () => {
				order.push('save');
				return true;
			},
		);
		assert.equal(ok, true);
		assert.deepEqual(order, ['apply', 'save']);
	});

	it('does not save when the edit is rejected', async () => {
		let saved = false;
		const ok = await applyEditThenSave(
			async () => false,
			async () => {
				saved = true;
				return true;
			},
		);
		assert.equal(ok, false);
		assert.equal(saved, false);
	});

	it('reports failure when the edit landed but the save did not', async () => {
		const ok = await applyEditThenSave(async () => true, async () => false);
		assert.equal(ok, false);
	});
});
