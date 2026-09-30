/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferModeKind, isToolAllowedInMode, selectToolsForJev, IntegrityToolName } from '../toolNames';

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

describe('selectToolsForJev', () => {
	const read = { name: IntegrityToolName.ReadFile };
	const create = { name: IntegrityToolName.CreateFile };
	const replace = { name: IntegrityToolName.ReplaceString };
	const patch = { name: IntegrityToolName.ApplyPatch };
	const terminal = { name: 'run_in_terminal' };
	const registered = [read, create, replace, patch, terminal];

	function names(tools: readonly { name: string }[]): string[] {
		return tools.map(tool => tool.name);
	}

	it('offers file tools the agent request omitted', () => {
		const request = new Map([[terminal, true]]);
		assert.deepEqual(names(selectToolsForJev('agent', request, registered)), [
			'run_in_terminal',
			IntegrityToolName.ReadFile,
			IntegrityToolName.CreateFile,
			IntegrityToolName.ReplaceString,
			IntegrityToolName.ApplyPatch,
		]);
	});

	it('keeps file tools out of ask mode', () => {
		const request = new Map([[read, true]]);
		assert.deepEqual(names(selectToolsForJev('ask', request, registered)), [
			IntegrityToolName.ReadFile,
		]);
	});

	it('does not put back a file tool the request disabled', () => {
		const request = new Map<typeof patch, boolean>([[patch, false], [terminal, true]]);
		assert.deepEqual(names(selectToolsForJev('agent', request, registered)), [
			'run_in_terminal',
			IntegrityToolName.ReadFile,
			IntegrityToolName.CreateFile,
			IntegrityToolName.ReplaceString,
		]);
	});

	it('does not add workbench tools the request left out', () => {
		const request = new Map([[read, true]]);
		assert.deepEqual(names(selectToolsForJev('agent', request, registered)), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.CreateFile,
			IntegrityToolName.ReplaceString,
			IntegrityToolName.ApplyPatch,
		]);
	});

	it('uses every mode-allowed registered tool when the request has no tool map', () => {
		assert.deepEqual(names(selectToolsForJev('edit', undefined, registered)), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.CreateFile,
			IntegrityToolName.ReplaceString,
			IntegrityToolName.ApplyPatch,
		]);
	});
});
