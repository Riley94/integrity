/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyPatchHunks,
	applyUniqueReplace,
	countOccurrences,
	isSensitivePath,
	normalizeWorkspaceRelativePath,
} from '../pathPolicy';

describe('isSensitivePath', () => {
	it('flags .env variants', () => {
		assert.equal(isSensitivePath('.env'), true);
		assert.equal(isSensitivePath('.env.local'), true);
		assert.equal(isSensitivePath('config/.env'), true);
		assert.equal(isSensitivePath('src/app.ts'), false);
	});
});

describe('normalizeWorkspaceRelativePath', () => {
	it('normalizes relative paths', () => {
		assert.equal(normalizeWorkspaceRelativePath('src/./a.ts'), 'src/a.ts');
		assert.equal(normalizeWorkspaceRelativePath('src/foo/../bar.ts'), 'src/bar.ts');
	});

	it('rejects absolute and escaping paths', () => {
		assert.equal(normalizeWorkspaceRelativePath('/etc/passwd'), undefined);
		assert.equal(normalizeWorkspaceRelativePath('C:/Windows'), undefined);
		assert.equal(normalizeWorkspaceRelativePath('../secret'), undefined);
		assert.equal(normalizeWorkspaceRelativePath('a/../../b'), undefined);
	});
});

describe('applyUniqueReplace', () => {
	it('replaces a unique match', () => {
		const result = applyUniqueReplace('hello world', 'world', 'there');
		assert.deepEqual(result, { ok: true, updated: 'hello there' });
	});

	it('fails when missing', () => {
		const result = applyUniqueReplace('hello', 'missing', 'x');
		assert.equal(result.ok, false);
	});

	it('fails when ambiguous', () => {
		const result = applyUniqueReplace('aaa', 'a', 'b');
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /3 times/);
		}
	});
});

describe('applyPatchHunks', () => {
	it('creates a missing file with empty oldText on the first hunk', () => {
		const result = applyPatchHunks(undefined, [{ newText: 'print(1)\n' }]);
		assert.deepEqual(result, { ok: true, updated: 'print(1)\n', created: true });
	});

	it('appends to an existing file with empty oldText', () => {
		const result = applyPatchHunks('hello\n', [{ newText: 'world\n' }]);
		assert.deepEqual(result, { ok: true, updated: 'hello\nworld\n', created: false });
	});

	it('applies sequential unique replaces', () => {
		const result = applyPatchHunks('alpha beta gamma', [
			{ oldText: 'alpha', newText: 'A' },
			{ oldText: 'gamma', newText: 'G' },
		]);
		assert.deepEqual(result, { ok: true, updated: 'A beta G', created: false });
	});

	it('fails on missing oldText without applying later hunks', () => {
		const result = applyPatchHunks('keep me', [
			{ oldText: 'missing', newText: 'x' },
			{ oldText: 'keep me', newText: 'changed' },
		]);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /hunk 0/);
			assert.match(result.error, /not found/);
		}
	});

	it('fails on ambiguous oldText without partial apply', () => {
		const result = applyPatchHunks('aaa', [
			{ oldText: 'a', newText: 'b' },
			{ newText: 'tail' },
		]);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /hunk 0/);
			assert.match(result.error, /3 times/);
		}
	});

	it('rejects empty hunks', () => {
		const result = applyPatchHunks('x', []);
		assert.equal(result.ok, false);
	});
});

describe('countOccurrences', () => {
	it('counts non-overlapping', () => {
		assert.equal(countOccurrences('ababab', 'ab'), 3);
		assert.equal(countOccurrences('aaa', 'aa'), 1);
	});
});
