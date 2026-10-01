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

	it('allows the scratchpad in ask and agent, and blocks it in edit', () => {
		assert.equal(isToolAllowedInMode(IntegrityToolName.Scratchpad, 'ask'), true);
		assert.equal(isToolAllowedInMode(IntegrityToolName.Scratchpad, 'agent'), true);
		assert.equal(isToolAllowedInMode(IntegrityToolName.Scratchpad, 'edit'), false);
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

	it('offers the scratchpad in ask when the request omitted it', () => {
		const scratchpad = { name: IntegrityToolName.Scratchpad };
		const request = new Map([[read, true]]);
		assert.deepEqual(names(selectToolsForJev('ask', request, [read, scratchpad, patch])), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.Scratchpad,
		]);
	});

	it('keeps the scratchpad out of edit mode', () => {
		const scratchpad = { name: IntegrityToolName.Scratchpad };
		assert.deepEqual(names(selectToolsForJev('edit', undefined, [read, scratchpad, patch])), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.ApplyPatch,
		]);
	});

	it('does not put back a scratchpad the request disabled', () => {
		const scratchpad = { name: IntegrityToolName.Scratchpad };
		const request = new Map<typeof scratchpad, boolean>([[scratchpad, false], [read, true]]);
		assert.deepEqual(names(selectToolsForJev('agent', request, [read, scratchpad])), [
			IntegrityToolName.ReadFile,
		]);
	});
});
