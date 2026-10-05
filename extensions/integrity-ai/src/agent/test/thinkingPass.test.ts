/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { THINKING_PART_ID } from '../thinkingPass';

describe('THINKING_PART_ID', () => {
	it('keeps a stable id for the Thinking box', () => {
		assert.equal(THINKING_PART_ID, 'integrity-thinking');
	});
});
