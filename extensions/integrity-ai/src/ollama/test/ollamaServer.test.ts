/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	commonOllamaPaths,
	ensureOllamaRunning,
	findOllamaBinary,
	hostEnvFromBaseUrl,
	isLocalOllamaUrl,
	normalizeOllamaBaseUrl,
	type OllamaServerDeps,
} from '../ollamaServer';

describe('isLocalOllamaUrl', () => {
	it('accepts loopback hosts', () => {
		assert.equal(isLocalOllamaUrl('http://127.0.0.1:11434'), true);
		assert.equal(isLocalOllamaUrl('http://localhost:11434'), true);
		assert.equal(isLocalOllamaUrl('http://[::1]:11434'), true);
		assert.equal(isLocalOllamaUrl('http://0.0.0.0:11434'), true);
		assert.equal(isLocalOllamaUrl('127.0.0.1:11434'), true);
	});

	it('rejects remote hosts and invalid URLs', () => {
		assert.equal(isLocalOllamaUrl('http://192.168.1.20:11434'), false);
		assert.equal(isLocalOllamaUrl('https://ollama.example.com'), false);
		assert.equal(isLocalOllamaUrl('not a url'), false);
	});
});

describe('hostEnvFromBaseUrl', () => {
	it('keeps an explicit port', () => {
		assert.equal(hostEnvFromBaseUrl('http://127.0.0.1:11435'), '127.0.0.1:11435');
	});

	it('defaults to Ollama\'s port when omitted', () => {
		assert.equal(hostEnvFromBaseUrl('http://localhost'), 'localhost:11434');
	});
});

describe('normalizeOllamaBaseUrl', () => {
	it('strips a trailing slash', () => {
		assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
	});
});

describe('commonOllamaPaths', () => {
	it('uses Windows program locations', () => {
		const paths = commonOllamaPaths('win32', 'C:\\Users\\dev', {
			LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
			ProgramFiles: 'C:\\Program Files',
		});
		assert.ok(paths.some(p => p.includes('AppData') && p.endsWith('ollama.exe')));
		assert.ok(paths.some(p => p.includes('Program Files') && p.endsWith('ollama.exe')));
	});

	it('includes ~/.local/bin on Unix', () => {
		const paths = commonOllamaPaths('linux', '/home/dev', {});
		assert.ok(paths.includes('/home/dev/.local/bin/ollama'));
		assert.ok(paths.includes('/usr/local/bin/ollama'));
	});
});

describe('findOllamaBinary', () => {
	it('prefers a PATH hit', async () => {
		const found = await findOllamaBinary({
			lookupPath: async () => '/usr/bin/ollama',
			exists: async (p) => p === '/usr/bin/ollama',
			platform: 'linux',
			homedir: () => '/home/dev',
			env: {},
		});
		assert.equal(found, '/usr/bin/ollama');
	});

	it('falls back to a known install path', async () => {
		const found = await findOllamaBinary({
			lookupPath: async () => undefined,
			exists: async (p) => p === '/home/dev/.local/bin/ollama',
			platform: 'linux',
			homedir: () => '/home/dev',
			env: {},
		});
		assert.equal(found, '/home/dev/.local/bin/ollama');
	});

	it('returns undefined when missing', async () => {
		const found = await findOllamaBinary({
			lookupPath: async () => undefined,
			exists: async () => false,
			platform: 'linux',
			homedir: () => '/home/dev',
			env: {},
		});
		assert.equal(found, undefined);
	});
});

function fakeClockDeps(overrides: Partial<OllamaServerDeps> & Pick<OllamaServerDeps, 'probe'>): OllamaServerDeps {
	const clock = { time: 0 };
	return {
		findBinary: async () => '/usr/bin/ollama',
		startProcess: async () => { },
		sleep: async (ms) => { clock.time += ms; },
		now: () => clock.time,
		...overrides,
	};
}

describe('ensureOllamaRunning', () => {
	const local = 'http://127.0.0.1:11434';

	it('returns already-running when the API is up', async () => {
		const result = await ensureOllamaRunning(local, fakeClockDeps({
			probe: async () => true,
		}));
		assert.deepEqual(result, { status: 'already-running' });
	});

	it('does not spawn for a remote URL', async () => {
		let started = false;
		const result = await ensureOllamaRunning('http://10.0.0.4:11434', fakeClockDeps({
			probe: async () => false,
			startProcess: async () => { started = true; },
		}));
		assert.deepEqual(result, { status: 'not-local', baseUrl: 'http://10.0.0.4:11434' });
		assert.equal(started, false);
	});

	it('returns not-installed when the CLI is missing', async () => {
		const result = await ensureOllamaRunning(local, fakeClockDeps({
			probe: async () => false,
			findBinary: async () => undefined,
		}));
		assert.deepEqual(result, { status: 'not-installed' });
	});

	it('starts and waits until the API is healthy', async () => {
		let probes = 0;
		let envPassed: NodeJS.ProcessEnv | undefined;
		const result = await ensureOllamaRunning(local, fakeClockDeps({
			probe: async () => ++probes > 2,
			startProcess: async (_binary, env) => { envPassed = env; },
		}));
		assert.deepEqual(result, { status: 'started' });
		assert.equal(envPassed?.OLLAMA_HOST, '127.0.0.1:11434');
	});

	it('reports start-failed when spawn throws', async () => {
		const result = await ensureOllamaRunning(local, fakeClockDeps({
			probe: async () => false,
			startProcess: async () => { throw new Error('spawn ENOENT'); },
		}));
		assert.deepEqual(result, { status: 'start-failed', message: 'spawn ENOENT' });
	});

	it('times out when the API never comes up', async () => {
		const result = await ensureOllamaRunning(local, fakeClockDeps({
			probe: async () => false,
		}), { timeoutMs: 1000, pollMs: 250 });
		assert.deepEqual(result, { status: 'timed-out' });
	});
});
