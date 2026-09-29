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
	extractPathFromInput,
	isPlaceholderPath,
	isSensitivePath,
	normalizePatchInput,
	normalizeWorkspaceRelativePath,
	pickUniqueBasenameMatch,
	resolveAgentFilePath,
	shouldLookupBasenameInWorkspace,
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

describe('extractPathFromInput / resolveAgentFilePath', () => {
	const roots = ['/home/user/project'];

	it('accepts path aliases like filePath', () => {
		const extracted = extractPathFromInput({ filePath: 'main.py', content: 'x' });
		assert.equal(extracted.raw, 'main.py');
		assert.equal(extracted.usedKey, 'filePath');

		const resolved = resolveAgentFilePath({ filePath: 'main.py', content: 'x' }, roots);
		assert.deepEqual(resolved, { ok: true, path: 'main.py' });
	});

	it('reports missing path with present keys', () => {
		const resolved = resolveAgentFilePath({ content: 'x' }, roots);
		assert.equal(resolved.ok, false);
		if (!resolved.ok) {
			assert.match(resolved.error, /Missing required "path"/);
			assert.match(resolved.error, /Got keys: content/);
			assert.match(resolved.error, /filePath/);
		}
	});

	it('relativizes absolute paths under the workspace', () => {
		const resolved = resolveAgentFilePath(
			{ path: '/home/user/project/main.py' },
			roots,
		);
		assert.deepEqual(resolved, { ok: true, path: 'main.py' });
	});

	it('relativizes nested absolute paths', () => {
		const resolved = resolveAgentFilePath(
			{ file_path: '/home/user/project/src/app.py' },
			roots,
		);
		assert.deepEqual(resolved, { ok: true, path: 'src/app.py' });
	});

	it('rejects absolute paths outside the workspace', () => {
		const resolved = resolveAgentFilePath({ path: '/etc/passwd' }, roots);
		assert.equal(resolved.ok, false);
		if (!resolved.ok) {
			assert.match(resolved.error, /not a usable workspace path|outside the workspace/);
			assert.equal(resolved.basenameLookup, 'passwd');
		}
	});

	it('flags placeholder paths for basename lookup', () => {
		assert.equal(isPlaceholderPath('/path/to/main.py'), true);
		assert.equal(shouldLookupBasenameInWorkspace('/path/to/main.py', roots), 'main.py');
		const resolved = resolveAgentFilePath({ filePath: '/path/to/main.py' }, roots);
		assert.equal(resolved.ok, false);
		if (!resolved.ok) {
			assert.equal(resolved.basenameLookup, 'main.py');
			assert.match(resolved.error, /placeholder/);
			assert.match(resolved.error, /Do not ask the user/);
		}
	});

	it('picks a unique basename match', () => {
		assert.deepEqual(
			pickUniqueBasenameMatch('main.py', ['src/main.py']),
			{ ok: true, path: 'src/main.py' },
		);
	});

	it('lists ambiguous basename matches without asking the user', () => {
		const result = pickUniqueBasenameMatch('main.py', ['main.py', 'pkg/main.py']);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /Multiple workspace files/);
			assert.match(result.error, /Do not ask the user/);
		}
	});

	it('handles file:// URIs under the workspace', () => {
		const resolved = resolveAgentFilePath(
			{ path: 'file:///home/user/project/main.py' },
			roots,
		);
		assert.deepEqual(resolved, { ok: true, path: 'main.py' });
	});

	it('defaults optional paths to .', () => {
		const resolved = resolveAgentFilePath({}, roots, { optional: true, defaultPath: '.' });
		assert.deepEqual(resolved, { ok: true, path: '.' });
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

describe('normalizePatchInput', () => {
	it('accepts a patch string as an append hunk', () => {
		const result = normalizePatchInput({
			filePath: 'main.py',
			patch: 'def add(a, b):\n    return a + b\n',
		});
		assert.deepEqual(result, {
			ok: true,
			hunks: [{ newText: 'def add(a, b):\n    return a + b\n' }],
		});
	});

	it('accepts hunks arrays', () => {
		const result = normalizePatchInput({
			path: 'main.py',
			hunks: [{ oldText: 'a', newText: 'b' }],
		});
		assert.deepEqual(result, {
			ok: true,
			hunks: [{ oldText: 'a', newText: 'b' }],
		});
	});

	it('errors clearly when patch body is missing', () => {
		const result = normalizePatchInput({ filePath: 'main.py' });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /Missing patch body/);
			assert.match(result.error, /Got keys: filePath/);
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

	it('inserts a newline when appending to content without a trailing newline', () => {
		const result = applyPatchHunks('hello', [{ newText: 'world' }]);
		assert.deepEqual(result, { ok: true, updated: 'hello\nworld', created: false });
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
