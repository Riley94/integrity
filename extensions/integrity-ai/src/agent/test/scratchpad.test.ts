/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	SCRATCHPAD_MAX_CODE_CHARS,
	executeScratchpad,
	scratchpadApprovalPreview,
	scratchpadEnv,
	virtualEnvRoot,
	workspacePythonCandidates,
} from '../scratchpad';

function stdoutOf(text: string): string {
	const start = text.indexOf('\nstdout:\n');
	const end = text.indexOf('\nstderr:\n');
	assert.ok(start >= 0 && end > start, text);
	return text.slice(start + '\nstdout:\n'.length, end);
}

/** Create `.venv` and return its site-packages directory, or undefined when venv cannot be created. */
async function createWorkspaceVenv(root: string): Promise<string | undefined> {
	const created = await new Promise<boolean>(resolve => {
		const child = spawn('python3', ['-m', 'venv', join(root, '.venv')], { stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('close', code => resolve(code === 0));
	});
	if (!created) {
		return undefined;
	}
	let versions: string[];
	try {
		versions = await readdir(join(root, '.venv', 'lib'));
	} catch {
		return undefined;
	}
	const py = versions.find(name => name.startsWith('python'));
	return py ? join(root, '.venv', 'lib', py, 'site-packages') : undefined;
}

function pythonReady(): Promise<boolean> {
	return new Promise(resolve => {
		const child = spawn('python3', ['-P', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
			stdio: 'ignore',
		});
		child.on('error', () => resolve(false));
		child.on('close', code => resolve(code === 0));
	});
}

describe('scratchpadEnv', () => {
	it('drops workspace roots from PYTHONPATH and leaves other entries', () => {
		const workspace = '/tmp/integrity-workspace';
		const other = '/opt/other';
		const base = {
			PYTHONPATH: `${workspace}${delimiter}${other}${delimiter}${workspace}-other`,
			PYTHONSTARTUP: '/tmp/startup.py',
		};
		const env = scratchpadEnv([workspace], base);
		assert.equal(env.PYTHONPATH, `${other}${delimiter}${workspace}-other`);
		assert.equal(env.PYTHONSTARTUP, undefined);
		assert.equal(env.PYTHONUNBUFFERED, '1');
		assert.equal(base.PYTHONSTARTUP, '/tmp/startup.py');
	});

	it('removes PYTHONPATH when every entry is inside the workspace', () => {
		const workspace = '/tmp/integrity-workspace';
		const env = scratchpadEnv([workspace], {
			PYTHONPATH: `${workspace}${delimiter}${workspace}/src`,
		});
		assert.equal(env.PYTHONPATH, undefined);
	});
});

describe('workspacePythonCandidates', () => {
	it('checks .venv before venv', () => {
		const candidates = workspacePythonCandidates('/work');
		if (process.platform === 'win32') {
			assert.deepEqual(candidates, [
				join('/work', '.venv', 'Scripts', 'python.exe'),
				join('/work', 'venv', 'Scripts', 'python.exe'),
			]);
			return;
		}
		assert.deepEqual(candidates, [
			'/work/.venv/bin/python',
			'/work/.venv/bin/python3',
			'/work/venv/bin/python',
			'/work/venv/bin/python3',
		]);
	});
});

describe('virtualEnvRoot', () => {
	it('recognizes a workspace virtual environment and ignores a system interpreter', () => {
		if (process.platform === 'win32') {
			assert.equal(virtualEnvRoot('C:\\work\\.venv\\Scripts\\python.exe'), 'C:\\work\\.venv');
			return;
		}
		assert.equal(virtualEnvRoot('/work/.venv/bin/python'), '/work/.venv');
		assert.equal(virtualEnvRoot('/work/venv/bin/python3'), '/work/venv');
		assert.equal(virtualEnvRoot('/usr/bin/python3'), undefined);
		assert.equal(virtualEnvRoot('python3'), undefined);
	});
});

describe('scratchpadApprovalPreview', () => {
	it('names the scratchpad and clips a long snippet', () => {
		assert.equal(scratchpadApprovalPreview('   '), 'Run Python scratchpad?');
		assert.equal(scratchpadApprovalPreview('print(1)'), 'Run Python scratchpad?\nprint(1)');
		const preview = scratchpadApprovalPreview('x'.repeat(200));
		assert.equal(preview, `Run Python scratchpad?\n${'x'.repeat(180)}…`);
	});
});

describe('executeScratchpad', () => {
	it('rejects an empty or oversized snippet without spawning', async () => {
		assert.equal(await executeScratchpad({ code: '   ' }), 'Empty snippet.');
		const huge = 'x'.repeat(SCRATCHPAD_MAX_CODE_CHARS + 1);
		const text = await executeScratchpad({ code: huge });
		assert.match(text, /Snippet is too long/);
	});

	it('reports a missing interpreter', async () => {
		const text = await executeScratchpad({
			code: 'print(1)\n',
			pythonCommand: 'integrity-scratchpad-missing-python',
		});
		assert.match(text, /^Scratchpad failed:/);
	});

	it('returns stdout from a snippet', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const text = await executeScratchpad({
			code: 'print("hello scratchpad")\n',
			pythonCommand: 'python3',
		});
		assert.match(text, /^exit_code: 0/);
		assert.equal(stdoutOf(text), 'hello scratchpad\n');
	});

	it('returns a non-zero exit and stderr when the snippet fails', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const text = await executeScratchpad({
			code: 'raise SystemExit("boom")\n',
			pythonCommand: 'python3',
		});
		assert.match(text, /^exit_code: 1/);
		assert.match(text, /boom/);
	});

	it('imports packages from the workspace .venv and not the project', async (t) => {
		if (process.platform === 'win32' || !await pythonReady()) {
			t.skip('workspace venv fixture needs python3 -P on Unix');
			return;
		}
		const workspace = await mkdtemp(join(tmpdir(), 'integrity-venv-workspace-'));
		try {
			const sitePackages = await createWorkspaceVenv(workspace);
			if (!sitePackages) {
				t.skip('python3 -m venv is unavailable');
				return;
			}
			await writeFile(join(sitePackages, 'venv_marker.py'), 'VALUE = 7\n');
			await writeFile(join(workspace, 'workspace_marker.py'), 'VALUE = 123\n');
			const text = await executeScratchpad({
				code: [
					'import os',
					'import venv_marker',
					'print(venv_marker.VALUE)',
					'print(os.environ.get("VIRTUAL_ENV", ""))',
					'try:',
					'    import workspace_marker',
					'    print(workspace_marker.VALUE)',
					'except ModuleNotFoundError:',
					'    print("not-imported")',
				].join('\n'),
				workspaceRoots: [workspace],
				baseEnv: { ...process.env, PYTHONPATH: workspace },
			});
			assert.match(text, /^exit_code: 0/);
			assert.match(text, new RegExp(`python: ${workspace}/\\.venv/bin/python`));
			const stdout = stdoutOf(text);
			assert.match(stdout, /^7\n/);
			assert.match(stdout, new RegExp(`${workspace}/\\.venv`));
			assert.match(stdout, /not-imported/);
			assert.doesNotMatch(stdout, /123/);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it('does not import the workspace and deletes the temp directory', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const workspace = await mkdtemp(join(tmpdir(), 'integrity-workspace-'));
		try {
			await writeFile(join(workspace, 'workspace_marker.py'), 'VALUE = 123\n');
			const text = await executeScratchpad({
				code: [
					'import os',
					'print(os.getcwd())',
					'try:',
					'    import workspace_marker',
					'    print(workspace_marker.VALUE)',
					'except ModuleNotFoundError:',
					'    print("not-imported")',
				].join('\n'),
				pythonCommand: 'python3',
				workspaceRoots: [workspace],
				baseEnv: { ...process.env, PYTHONPATH: workspace },
			});
			assert.match(text, /^exit_code: 0/);
			const stdout = stdoutOf(text);
			assert.match(stdout, /not-imported/);
			assert.doesNotMatch(stdout, /123/);
			const cwd = stdout.split('\n')[0];
			assert.match(cwd, /integrity-scratchpad-/);
			assert.notEqual(cwd, workspace);
			await assert.rejects(access(cwd));
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it('times out a snippet that does not finish', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const text = await executeScratchpad({
			code: 'import time\ntime.sleep(30)\n',
			pythonCommand: 'python3',
			timeoutMs: 500,
		});
		assert.match(text, /timed_out: true/);
		assert.match(text, /exit_code: null/);
	});

	it('cancels when the signal aborts', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const abort = new AbortController();
		const pending = executeScratchpad({
			code: 'import time\ntime.sleep(30)\n',
			pythonCommand: 'python3',
			timeoutMs: 10_000,
			signal: abort.signal,
		});
		abort.abort();
		const text = await pending;
		assert.match(text, /cancelled: true/);
	});

	it('truncates oversized output', async (t) => {
		if (!await pythonReady()) {
			t.skip('python3 -P is unavailable');
			return;
		}
		const text = await executeScratchpad({
			code: 'print("x" * 1000)\n',
			pythonCommand: 'python3',
			maxOutputChars: 50,
		});
		assert.match(text, /truncated: true/);
		assert.ok(stdoutOf(text).length <= 50);
	});
});
