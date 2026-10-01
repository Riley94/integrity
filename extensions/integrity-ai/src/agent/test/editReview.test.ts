/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	editReviewMessage,
	editReviewPending,
	emptyEditReviewState,
	holdReplyForEditReview,
	MAX_EDIT_REVIEWS,
	noteToolResult,
	withReviewReadTool,
	type EditReviewState,
} from '../editReview';
import { IntegrityToolName } from '../toolNames';

const readFile = { name: IntegrityToolName.ReadFile, description: 'Read a file.' };
const createFile = { name: IntegrityToolName.CreateFile, description: 'Create a file.' };
const replace = { name: IntegrityToolName.ReplaceString, description: 'Replace text.' };

function write(state: EditReviewState, tool: string, result: string): EditReviewState {
	return noteToolResult(state, tool, { path: 'ignored.ts' }, result);
}

describe('noteToolResult', () => {
	it('records a created or updated file once', () => {
		let state = emptyEditReviewState();
		state = write(state, IntegrityToolName.CreateFile, 'Created src/a.ts');
		state = write(state, IntegrityToolName.ApplyPatch, 'Updated src/a.ts');
		state = write(state, IntegrityToolName.ReplaceString, 'Updated src/b.ts');
		assert.deepEqual(state.unread, ['src/a.ts', 'src/b.ts']);
	});

	it('ignores failed writes, cancellations, and non-file tools', () => {
		let state = emptyEditReviewState();
		state = write(state, IntegrityToolName.CreateFile, 'Failed to create src/a.ts');
		state = write(state, IntegrityToolName.CreateFile, 'File already exists: src/a.ts. Use integrity_apply_patch to modify it, or pass overwrite=true to replace.');
		state = write(state, IntegrityToolName.ReplaceString, 'oldText not found in file.');
		state = write(state, IntegrityToolName.ApplyPatch, 'Failed to apply patch to src/a.ts');
		state = write(state, IntegrityToolName.CreateFile, 'Tool error: integrity_create_file cancelled by user.');
		state = write(state, IntegrityToolName.Scratchpad, 'Created src/a.ts');
		assert.deepEqual(state.unread, []);
	});

	it('normalizes the written path', () => {
		const state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created ./src/a.ts');
		assert.deepEqual(state.unread, ['src/a.ts']);
	});

	it('clears a file once it is read after the write', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		state = write(state, IntegrityToolName.ReplaceString, 'Updated src/b.ts');
		state = noteToolResult(state, IntegrityToolName.ReadFile, { path: './src/a.ts' }, 'export const a = 1;\n');
		assert.deepEqual(state.unread, ['src/b.ts']);
		state = noteToolResult(state, IntegrityToolName.ReadFile, { filePath: 'src/b.ts' }, '(empty tool result)');
		assert.deepEqual(state.unread, []);
	});

	it('keeps a file unread when the read fails or opens a different path', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		state = noteToolResult(state, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'File not found: src/a.ts');
		state = noteToolResult(state, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'Tool error: integrity_read_file cancelled by user.');
		state = noteToolResult(state, IntegrityToolName.ReadFile, { path: 'src/other.ts' }, 'Created src/b.ts\n');
		assert.deepEqual(state.unread, ['src/a.ts']);
	});

	it('marks a file unread again when a later edit follows the read', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		state = noteToolResult(state, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'export const a = 1;\n');
		state = write(state, IntegrityToolName.ReplaceString, 'Updated src/a.ts');
		assert.deepEqual(state.unread, ['src/a.ts']);
	});
});

describe('holdReplyForEditReview', () => {
	it('asks for one read of the files written so far', () => {
		const state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		const held = holdReplyForEditReview(state, true);
		assert.equal(held.action, 'continue');
		if (held.action !== 'continue') {
			return;
		}
		assert.equal(held.state.reviews, 1);
		assert.deepEqual(held.state.unread, ['src/a.ts']);
		assert.equal(held.message, editReviewMessage(['src/a.ts']));
		assert.match(held.message, /integrity_read_file/);
		assert.match(held.message, /src\/a\.ts/);
		assert.match(held.message, /previous summary was not shown/);
	});

	it('ends the turn once those files have been read and not edited again', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		const held = holdReplyForEditReview(state, true);
		assert.equal(held.action, 'continue');
		if (held.action !== 'continue') {
			return;
		}
		state = noteToolResult(held.state, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'export const a = 1;\n');
		assert.equal(editReviewPending(state), false);
		assert.deepEqual(holdReplyForEditReview(state, true), { action: 'exit' });
	});

	it('reviews the revised file and stops after three passes', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.ReplaceString, 'Updated src/a.ts');
		for (let pass = 1; pass <= MAX_EDIT_REVIEWS; pass++) {
			const held = holdReplyForEditReview(state, true);
			assert.equal(held.action, 'continue');
			if (held.action !== 'continue') {
				return;
			}
			assert.equal(held.state.reviews, pass);
			state = noteToolResult(held.state, IntegrityToolName.ReadFile, { path: 'src/a.ts' }, 'v' + pass);
			if (pass < MAX_EDIT_REVIEWS) {
				state = write(state, IntegrityToolName.ReplaceString, 'Updated src/a.ts');
			}
		}
		assert.deepEqual(holdReplyForEditReview(state, true), { action: 'exit' });

		state = write(state, IntegrityToolName.ReplaceString, 'Updated src/a.ts');
		assert.equal(editReviewPending(state), false);
		assert.deepEqual(holdReplyForEditReview(state, true), { action: 'exit' });
	});

	it('stops asking after three reviews even when the file was never read', () => {
		let state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		for (let pass = 1; pass <= MAX_EDIT_REVIEWS; pass++) {
			const held = holdReplyForEditReview(state, true);
			assert.equal(held.action, 'continue');
			if (held.action !== 'continue') {
				return;
			}
			assert.equal(held.state.reviews, pass);
			state = held.state;
		}
		assert.deepEqual(state.unread, ['src/a.ts']);
		assert.equal(editReviewPending(state), false);
		assert.deepEqual(holdReplyForEditReview(state, true), { action: 'exit' });
	});

	it('does not hold the reply when the read tool cannot be offered', () => {
		const state = write(emptyEditReviewState(), IntegrityToolName.CreateFile, 'Created src/a.ts');
		assert.deepEqual(holdReplyForEditReview(state, false), { action: 'exit' });
	});

	it('does not hold a turn that has not written a file', () => {
		assert.deepEqual(holdReplyForEditReview(emptyEditReviewState(), true), { action: 'exit' });
	});
});

describe('withReviewReadTool', () => {
	it('appends the read tool from the catalog when a review needs it', () => {
		const next = withReviewReadTool([createFile, replace], [createFile, replace, readFile]);
		assert.deepEqual(next.map(tool => tool.name), [
			IntegrityToolName.CreateFile,
			IntegrityToolName.ReplaceString,
			IntegrityToolName.ReadFile,
		]);
	});

	it('leaves the selection alone when the read tool is already there or was not offered', () => {
		const selected = [readFile, createFile];
		assert.equal(withReviewReadTool(selected, [readFile, createFile]), selected);
		const onlyCreate = [createFile];
		assert.equal(withReviewReadTool(onlyCreate, [createFile, replace]), onlyCreate);
	});
});
