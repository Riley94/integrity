/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	beginLookPhase,
	emptyLookPhaseState,
	emptyReadSinceWriteState,
	finishLookPhase,
	holdReplyForLookPhase,
	LOOK_PLAN_CONTINUE_MESSAGE,
	LOOK_REQUIRED_MESSAGE,
	noteLookObservation,
	noteReadSinceWrite,
	planFromObservedReply,
	rejectionForUnreadEdit,
	toolsAfterObservation,
} from '../lookPhase';
import { IntegrityToolName } from '../toolNames';

const readFile = { name: IntegrityToolName.ReadFile, description: 'Read a file.' };
const listDir = { name: IntegrityToolName.ListDir, description: 'List a directory.' };
const grep = { name: IntegrityToolName.GrepSearch, description: 'Search text.' };
const fileSearch = { name: IntegrityToolName.FileSearch, description: 'Find files.' };
const codebase = { name: IntegrityToolName.CodebaseSearch, description: 'Search the index.' };
const errors = { name: IntegrityToolName.GetErrors, description: 'Read diagnostics.' };
const createFile = { name: IntegrityToolName.CreateFile, description: 'Create a file.' };
const patch = { name: IntegrityToolName.ApplyPatch, description: 'Apply a patch.' };
const scratchpad = { name: IntegrityToolName.Scratchpad, description: 'Run Python.' };
const terminal = { name: 'run_in_terminal', description: 'Run a command.' };

const catalog = [readFile, listDir, grep, fileSearch, codebase, errors, createFile, patch, scratchpad, terminal];

describe('beginLookPhase', () => {
	it('withholds edit and terminal tools and keeps the scratchpad', () => {
		const selected = [createFile, patch, scratchpad, terminal];
		const looked = beginLookPhase(selected, catalog);
		assert.equal(looked.active, true);
		assert.deepEqual(looked.tools.map(tool => tool.name), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.ListDir,
			IntegrityToolName.GrepSearch,
			IntegrityToolName.FileSearch,
			IntegrityToolName.CodebaseSearch,
			IntegrityToolName.GetErrors,
			IntegrityToolName.Scratchpad,
		]);
		assert.deepEqual(selected.map(tool => tool.name), [
			IntegrityToolName.CreateFile,
			IntegrityToolName.ApplyPatch,
			IntegrityToolName.Scratchpad,
			'run_in_terminal',
		]);
	});

	it('does not add a scratchpad Jev left out', () => {
		const looked = beginLookPhase([createFile], catalog);
		assert.equal(looked.tools.some(tool => tool.name === IntegrityToolName.Scratchpad), false);
	});

	it('stays inactive when Jev kept no edit tool', () => {
		const selected = [readFile, listDir];
		const looked = beginLookPhase(selected, catalog);
		assert.equal(looked.active, false);
		assert.deepEqual(looked.tools, [...selected]);
	});

	it('stays inactive when the catalog cannot list, search, or read', () => {
		const selected = [createFile, errors];
		const looked = beginLookPhase(selected, [createFile, errors]);
		assert.equal(looked.active, false);
		assert.deepEqual(looked.tools, [...selected]);
	});
});

describe('noteLookObservation', () => {
	it('counts an empty listing and an empty search', () => {
		let state = emptyLookPhaseState(true);
		state = noteLookObservation(state, IntegrityToolName.ListDir, '(empty)');
		assert.equal(state.observed, true);
		state = emptyLookPhaseState(true);
		state = noteLookObservation(state, IntegrityToolName.GrepSearch, 'No matches.');
		assert.equal(state.observed, true);
		state = noteLookObservation(state, IntegrityToolName.FileSearch, 'No files matched.');
		assert.equal(state.observed, true);
	});

	it('counts a read and ignores failures and other tools', () => {
		let state = emptyLookPhaseState(true);
		state = noteLookObservation(state, IntegrityToolName.ReadFile, 'File not found: main.py');
		state = noteLookObservation(state, IntegrityToolName.ListDir, 'Directory not found: missing');
		state = noteLookObservation(state, IntegrityToolName.GrepSearch, 'pattern is required.');
		state = noteLookObservation(state, IntegrityToolName.GetErrors, 'No errors or warnings.');
		state = noteLookObservation(state, IntegrityToolName.Scratchpad, 'hello\n');
		assert.equal(state.observed, false);
		state = noteLookObservation(state, IntegrityToolName.ReadFile, 'print(1)\n');
		assert.equal(state.observed, true);
		const again = noteLookObservation(state, IntegrityToolName.ReadFile, 'Tool error: cancelled');
		assert.equal(again.observed, true);
	});

	it('leaves an inactive phase unchanged', () => {
		const state = emptyLookPhaseState(false);
		assert.equal(noteLookObservation(state, IntegrityToolName.ListDir, '(empty)'), state);
	});
});

describe('holdReplyForLookPhase', () => {
	it('holds a text reply until a look tool has succeeded', () => {
		const held = holdReplyForLookPhase(emptyLookPhaseState(true));
		assert.deepEqual(held, { action: 'hold', message: LOOK_REQUIRED_MESSAGE });
	});

	it('accepts the first text reply after an observation as the plan', () => {
		let state = noteLookObservation(emptyLookPhaseState(true), IntegrityToolName.ListDir, '(empty)');
		const decided = holdReplyForLookPhase(state);
		assert.deepEqual(decided, { action: 'plan', message: LOOK_PLAN_CONTINUE_MESSAGE });
		state = finishLookPhase(state, '  Create calculator.py.\n');
		assert.equal(state.active, false);
		assert.equal(state.observed, true);
		assert.equal(state.plan, 'Create calculator.py.');
		assert.equal(holdReplyForLookPhase(state).action, 'inactive');
	});

	it('leaves a turn that is not looking alone', () => {
		assert.deepEqual(holdReplyForLookPhase(emptyLookPhaseState(false)), { action: 'inactive' });
	});
});

describe('toolsAfterObservation', () => {
	it('stops offering list and read so the next step is the plan', () => {
		const looked = beginLookPhase([createFile, patch, scratchpad], catalog);
		assert.deepEqual(toolsAfterObservation(looked.tools, false), []);
		assert.deepEqual(
			toolsAfterObservation(looked.tools, true).map(tool => tool.name),
			[IntegrityToolName.Scratchpad],
		);
	});
});

describe('planFromObservedReply', () => {
	it('keeps prose and ignores a blank reply', () => {
		assert.equal(planFromObservedReply('  Create calculator.py.\n'), 'Create calculator.py.');
		assert.equal(planFromObservedReply('  \n'), undefined);
	});
});

describe('rejectionForUnreadEdit', () => {
	it('rejects a patch or replace until that file has been read', () => {
		let reads = emptyReadSinceWriteState();
		assert.match(
			rejectionForUnreadEdit(IntegrityToolName.ApplyPatch, { path: 'src/a.ts' }, reads.paths) ?? '',
			/Read src\/a\.ts with integrity_read_file/,
		);
		assert.match(
			rejectionForUnreadEdit(IntegrityToolName.ReplaceString, { filePath: 'src/a.ts' }, reads.paths) ?? '',
			/not been read since its last write/,
		);
		assert.equal(rejectionForUnreadEdit(IntegrityToolName.CreateFile, { path: 'src/a.ts' }, reads.paths), undefined);

		reads = noteReadSinceWrite(reads, IntegrityToolName.ReadFile, { path: './src/a.ts' }, 'export const a = 1;\n');
		assert.equal(rejectionForUnreadEdit(IntegrityToolName.ApplyPatch, { path: 'src/a.ts' }, reads.paths), undefined);
		assert.equal(rejectionForUnreadEdit(IntegrityToolName.ReplaceString, { path: 'src/a.ts' }, reads.paths), undefined);

		reads = noteReadSinceWrite(reads, IntegrityToolName.ApplyPatch, { path: 'src/a.ts' }, 'Updated src/a.ts');
		assert.match(
			rejectionForUnreadEdit(IntegrityToolName.ReplaceString, { path: 'src/a.ts' }, reads.paths) ?? '',
			/Read src\/a\.ts with integrity_read_file/,
		);
	});

	it('ignores a failed read and a failed write', () => {
		let reads = emptyReadSinceWriteState();
		reads = noteReadSinceWrite(reads, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'File not found: src/a.ts');
		reads = noteReadSinceWrite(reads, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'export const a = 1;\n');
		reads = noteReadSinceWrite(reads, IntegrityToolName.CreateFile, { path: 'src/a.ts' }, 'Failed to create src/a.ts');
		assert.deepEqual(reads.paths, ['src/a.ts']);
	});

	it('names the file when the edit call has no path', () => {
		const rejection = rejectionForUnreadEdit(IntegrityToolName.ApplyPatch, {}, []);
		assert.match(rejection ?? '', /Read the file with integrity_read_file/);
	});
});
