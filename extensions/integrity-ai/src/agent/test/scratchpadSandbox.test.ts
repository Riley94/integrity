/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { describe, it } from 'node:test';
import { bubblewrapArgs, pruneNestedMounts, scratchpadProcessEnv } from '../scratchpadSandbox';

describe('scratchpadProcessEnv', () => {
	it('names only the scratch directory and the interpreter', () => {
		const env = scratchpadProcessEnv('/tmp/integrity-scratchpad-1', '/usr/bin/python3');
		assert.equal(env.HOME, '/tmp/integrity-scratchpad-1');
		assert.equal(env.TMPDIR, '/tmp/integrity-scratchpad-1');
		assert.equal(env.PATH, '/usr/bin');
		assert.equal(env.PYTHONUNBUFFERED, '1');
		assert.equal(env.PYTHONNOUSERSITE, '1');
		assert.equal(env.PYTHONPATH, undefined);
		assert.equal(env.VIRTUAL_ENV, undefined);
		assert.equal(Object.keys(env).includes('SECRET'), false);
	});

	it('adds the virtual environment bin without replacing the interpreter directory', () => {
		const env = scratchpadProcessEnv('/tmp/integrity-scratchpad-1', '/usr/bin/python3', '/work/.venv');
		assert.equal(env.VIRTUAL_ENV, '/work/.venv');
		assert.equal(env.PATH, `/work/.venv/bin${delimiter}/usr/bin`);
	});
});

describe('pruneNestedMounts', () => {
	it('keeps sibling files and drops children of a mounted directory', () => {
		assert.deepEqual(pruneNestedMounts([
			'/',
			'/usr/lib/python3.12/lib-dynload/math.so',
			'/usr/bin/python3.12',
			'/usr/lib/python3.12',
			'/usr/bin/python3',
			'/usr/lib/python3.12',
		]), [
			'/usr/bin/python3',
			'/usr/bin/python3.12',
			'/usr/lib/python3.12',
		]);
	});
});

describe('bubblewrapArgs', () => {
	it('imports runtime mounts read-only and leaves only the scratch directory writable', () => {
		const env = scratchpadProcessEnv('/tmp/integrity-scratchpad-1', '/usr/bin/python3');
		const args = bubblewrapArgs({
			bwrap: 'bwrap',
			python: '/usr/bin/python3',
			script: '/tmp/integrity-scratchpad-1/snippet.py',
			scratchDir: '/tmp/integrity-scratchpad-1',
			readOnlyMounts: ['/usr/lib/python3.12', '/lib64/ld-linux-x86-64.so.2'],
			env,
		});
		assert.equal(args[0], 'bwrap');
		assert.ok(args.includes('--unshare-all'));
		assert.ok(args.includes('--clearenv'));
		const tmpfs = args.indexOf('--tmpfs');
		const scratchBind = args.indexOf('--bind');
		assert.ok(tmpfs >= 0 && scratchBind > tmpfs);
		assert.deepEqual(args.slice(scratchBind, scratchBind + 3), [
			'--bind',
			'/tmp/integrity-scratchpad-1',
			'/tmp/integrity-scratchpad-1',
		]);
		assert.ok(args.includes('--ro-bind'));
		assert.equal(args.at(-4), '--');
		assert.deepEqual(args.slice(-3), ['/usr/bin/python3', '-P', '/tmp/integrity-scratchpad-1/snippet.py']);
		assert.equal(args.includes('--setenv') && args[args.indexOf('HOME') - 1] === '--setenv', true);
		assert.equal(args.includes('SECRET'), false);
		assert.equal(args.includes('PYTHONPATH'), false);
	});
});
