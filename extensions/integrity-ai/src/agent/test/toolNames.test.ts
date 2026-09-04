/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferModeKind, isToolAllowedInMode, IntegrityToolName } from '../toolNames';

describe('inferModeKind', () => {
	it('detects ask/edit/agent', () => {
		assert.equal(inferModeKind('Ask'), 'ask');
		assert.equal(inferModeKind('Edit'), 'edit');
		assert.equal(inferModeKind('Agent'), 'agent');
		assert.equal(inferModeKind(undefined), 'agent');
	});
});

describe('isToolAllowedInMode', () => {
	it('allows read tools everywhere', () => {
		assert.equal(isToolAllowedInMode(IntegrityToolName.ReadFile, 'ask'), true);
		assert.equal(isToolAllowedInMode(IntegrityToolName.ReplaceString, 'ask'), false);
		assert.equal(isToolAllowedInMode(IntegrityToolName.ReplaceString, 'edit'), true);
		assert.equal(isToolAllowedInMode('run_in_terminal', 'edit'), false);
		assert.equal(isToolAllowedInMode('run_in_terminal', 'agent'), true);
	});

	it('allows integrity_apply_patch in edit/agent and blocks it in ask', () => {
		assert.equal(isToolAllowedInMode(IntegrityToolName.ApplyPatch, 'ask'), false);
		assert.equal(isToolAllowedInMode(IntegrityToolName.ApplyPatch, 'edit'), true);
		assert.equal(isToolAllowedInMode(IntegrityToolName.ApplyPatch, 'agent'), true);
	});
});
