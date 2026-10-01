/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	continuationTask,
	noteSessionWrite,
	PREVIOUS_USER_PROMPT_CLIP,
	previousUserPrompt,
	SESSION_FILE_CAP,
	SESSION_FILES_METADATA_KEY,
	sessionFilesResult,
	unionSessionFiles,
	type SessionFileRecord,
	type SessionHistoryTurn,
} from '../sessionFiles';
import { IntegrityToolName } from '../toolNames';

function write(files: readonly SessionFileRecord[], tool: string, result: string): readonly SessionFileRecord[] {
	return noteSessionWrite(files, tool, result);
}

describe('noteSessionWrite', () => {
	it('records created and updated files', () => {
		let files = write([], IntegrityToolName.CreateFile, 'Created src/app.py');
		files = write(files, IntegrityToolName.ReplaceString, 'Updated src/calc.py');
		files = write(files, IntegrityToolName.ApplyPatch, 'Updated ./src/app.py');
		assert.deepEqual(files, [
			{ path: 'src/app.py', action: 'created' },
			{ path: 'src/calc.py', action: 'updated' },
		]);
	});

	it('ignores failures, cancellations, reads, and non-file tools', () => {
		let files = write([], IntegrityToolName.CreateFile, 'Failed to create src/app.py');
		files = write(files, IntegrityToolName.CreateFile, 'File already exists: src/app.py. Use integrity_apply_patch to modify it, or pass overwrite=true to replace.');
		files = write(files, IntegrityToolName.ReplaceString, 'oldText not found in file.');
		files = write(files, IntegrityToolName.ApplyPatch, 'Failed to apply patch to src/app.py');
		files = write(files, IntegrityToolName.CreateFile, 'Tool error: integrity_create_file cancelled by user.');
		files = write(files, IntegrityToolName.ReadFile, 'Created src/app.py');
		files = write(files, IntegrityToolName.Scratchpad, 'Created src/app.py');
		assert.deepEqual(files, []);
	});

	it('keeps created when the same turn later updates that path', () => {
		let files = write([], IntegrityToolName.CreateFile, 'Created app.py');
		files = write(files, IntegrityToolName.ReplaceString, 'Updated app.py');
		assert.deepEqual(files, [{ path: 'app.py', action: 'created' }]);
	});
});

describe('sessionFilesResult', () => {
	it('omits metadata when the turn wrote nothing', () => {
		assert.deepEqual(sessionFilesResult([]), {});
	});

	it('stores the list under the session-files key', () => {
		const result = sessionFilesResult([{ path: 'app.py', action: 'created' }]);
		assert.deepEqual(result.metadata?.[SESSION_FILES_METADATA_KEY], [
			{ path: 'app.py', action: 'created' },
		]);
	});
});

describe('unionSessionFiles', () => {
	it('keeps created when a later turn only updates that path', () => {
		const first = sessionFilesResult([{ path: 'app.py', action: 'created' }]);
		const second = sessionFilesResult([
			{ path: 'app.py', action: 'updated' },
			{ path: 'src/calc.py', action: 'updated' },
		]);
		assert.deepEqual(unionSessionFiles([
			{ metadata: first.metadata },
			{ metadata: second.metadata },
		]), [
			{ path: 'app.py', action: 'created' },
			{ path: 'src/calc.py', action: 'updated' },
		]);
	});

	it('drops the oldest paths past the cap', () => {
		const turns = [];
		for (let i = 0; i < SESSION_FILE_CAP + 1; i++) {
			turns.push(sessionFilesResult([{ path: `file-${i}.py`, action: 'created' as const }]));
		}
		const files = unionSessionFiles(turns.map(turn => ({ metadata: turn.metadata })));
		assert.equal(files.length, SESSION_FILE_CAP);
		assert.equal(files[0]?.path, 'file-1.py');
		assert.equal(files.at(-1)?.path, `file-${SESSION_FILE_CAP}.py`);
		assert.equal(files.some(file => file.path === 'file-0.py'), false);
	});

	it('skips malformed metadata', () => {
		const files = unionSessionFiles([
			{ metadata: { [SESSION_FILES_METADATA_KEY]: [{ path: 'app.py', action: 'created' }, { path: 1 }, null, { path: '/abs.py', action: 'created' }] } },
			{ metadata: undefined },
			{},
		]);
		assert.deepEqual(files, [{ path: 'app.py', action: 'created' }]);
	});
});

describe('continuationTask', () => {
	const turns: SessionHistoryTurn[] = [
		{ kind: 'user', prompt: 'Make a Python app with a calculator button.' },
		{ kind: 'assistant', metadata: sessionFilesResult([{ path: 'app.py', action: 'created' }]).metadata },
	];

	it('includes the new prompt, the previous prompt, and the paths', () => {
		const task = continuationTask('Implement that.', previousUserPrompt(turns), unionSessionFiles(turns));
		assert.match(task, /^Implement that\./);
		assert.match(task, /Earlier in this chat the user asked:/);
		assert.match(task, /Make a Python app with a calculator button\./);
		assert.match(task, /- app\.py \(created\)/);
	});

	it('clips the previous user prompt', () => {
		const previous = 'p'.repeat(PREVIOUS_USER_PROMPT_CLIP) + 'TAIL';
		const task = continuationTask('Implement that.', previous, [{ path: 'app.py', action: 'created' }]);
		assert.match(task, /p{10}…/);
		assert.doesNotMatch(task, /TAIL/);
	});

	it('does not invent a section when no files were written', () => {
		const task = continuationTask('Implement that.', 'Make a Python app.', []);
		assert.equal(task, 'Implement that.');
		assert.doesNotMatch(task, /Earlier in this chat/);
		assert.doesNotMatch(task, /Files already changed/);
	});

	it('uses the latest user prompt as the previous request', () => {
		const history: SessionHistoryTurn[] = [
			{ kind: 'user', prompt: 'First request.' },
			{ kind: 'assistant' },
			{ kind: 'user', prompt: 'Second request.' },
		];
		assert.equal(previousUserPrompt(history), 'Second request.');
		assert.equal(previousUserPrompt([]), '');
	});
});
