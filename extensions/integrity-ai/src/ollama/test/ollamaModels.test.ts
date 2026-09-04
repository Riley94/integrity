/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ensureOllamaModelInstalled,
	formatByteSize,
	installPromptCopy,
	isOllamaModelInstalled,
	listInstalledOllamaModels,
	lookupOllamaModelSize,
	normalizeOllamaModelName,
	ollamaModelNamesMatch,
	ollamaModelNotReadyMessage,
	parseOllamaModelRef,
	pullOllamaModel,
	type EnsureOllamaModelDeps,
} from '../ollamaModels';

describe('parseOllamaModelRef', () => {
	it('fills library/latest for a bare name', () => {
		assert.deepEqual(parseOllamaModelRef('llama3'), {
			registry: 'registry.ollama.ai',
			namespace: 'library',
			repository: 'llama3',
			tag: 'latest',
		});
	});

	it('keeps an official tagged model', () => {
		assert.deepEqual(parseOllamaModelRef('qwen2.5-coder:14b'), {
			registry: 'registry.ollama.ai',
			namespace: 'library',
			repository: 'qwen2.5-coder',
			tag: '14b',
		});
	});

	it('parses a user namespace', () => {
		assert.deepEqual(parseOllamaModelRef('alice/custom:7b'), {
			registry: 'registry.ollama.ai',
			namespace: 'alice',
			repository: 'custom',
			tag: '7b',
		});
	});

	it('parses an explicit registry host', () => {
		assert.deepEqual(parseOllamaModelRef('ghcr.io/org/model:tag'), {
			registry: 'ghcr.io',
			namespace: 'org',
			repository: 'model',
			tag: 'tag',
		});
	});

	it('strips a digest pin before parsing', () => {
		assert.equal(parseOllamaModelRef('llama3:latest@sha256:abc').tag, 'latest');
	});
});

describe('normalizeOllamaModelName / match', () => {
	it('adds :latest and omits the library namespace', () => {
		assert.equal(normalizeOllamaModelName('llama3'), 'llama3:latest');
		assert.equal(normalizeOllamaModelName('library/llama3:latest'), 'llama3:latest');
	});

	it('treats equivalent names as installed', () => {
		assert.equal(ollamaModelNamesMatch('qwen2.5-coder:14b', 'library/qwen2.5-coder:14b'), true);
		assert.equal(ollamaModelNamesMatch('llama3', 'llama3:latest'), true);
		assert.equal(isOllamaModelInstalled('qwen2.5-coder:14b', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']), true);
		assert.equal(isOllamaModelInstalled('qwen2.5-coder:14b', ['qwen2.5-coder:7b']), false);
	});
});

describe('formatByteSize', () => {
	it('formats bytes through gigabytes', () => {
		assert.equal(formatByteSize(500), '500 B');
		assert.equal(formatByteSize(1024), '1.0 KB');
		assert.equal(formatByteSize(4.7 * 1024 ** 3), '4.7 GB');
	});
});

describe('installPromptCopy', () => {
	it('includes the formatted size when known', () => {
		const copy = installPromptCopy('qwen2.5-coder:14b', 9 * 1024 ** 3);
		assert.equal(copy.message, 'Install Ollama model "qwen2.5-coder:14b"?');
		assert.match(copy.detail, /about 9\.0 GB of disk space/);
	});

	it('omits size when unknown', () => {
		const copy = installPromptCopy('mystery', undefined);
		assert.match(copy.detail, /Ollama library/);
		assert.equal(copy.detail.includes('disk space'), false);
	});
});

describe('ollamaModelNotReadyMessage', () => {
	it('mentions size-independent install failure details', () => {
		assert.match(ollamaModelNotReadyMessage('qwen2.5-coder:14b', { status: 'failed', message: 'disk full' }), /disk full/);
		assert.match(ollamaModelNotReadyMessage('qwen2.5-coder:14b', { status: 'declined' }), /not installed/);
	});
});

describe('listInstalledOllamaModels', () => {
	it('collects name and model fields', async () => {
		const names = await listInstalledOllamaModels('http://127.0.0.1:11434/', async () => jsonResponse({
			models: [
				{ name: 'qwen2.5-coder:14b', model: 'qwen2.5-coder:14b' },
				{ name: 'nomic-embed-text:latest' },
			],
		}));
		assert.deepEqual(names.sort(), ['nomic-embed-text:latest', 'qwen2.5-coder:14b']);
	});

	it('returns [] when tags is not ok', async () => {
		const names = await listInstalledOllamaModels('http://127.0.0.1:11434', async () => new Response('nope', { status: 500 }));
		assert.deepEqual(names, []);
	});
});

describe('lookupOllamaModelSize', () => {
	it('sums config + layer sizes from a direct manifest', async () => {
		const size = await lookupOllamaModelSize('qwen2.5-coder:7b', {
			fetchFn: async () => jsonResponse({
				config: { size: 100 },
				layers: [{ size: 1000 }, { size: 250 }],
			}),
		});
		assert.equal(size, 1350);
	});

	it('follows an OCI index to the matching platform manifest', async () => {
		const size = await lookupOllamaModelSize('llama3:latest', {
			preferredArch: 'arm64',
			preferredOs: 'linux',
			fetchFn: async (input) => {
				const url = String(input);
				if (url.endsWith('/manifests/latest')) {
					return jsonResponse({
						mediaType: 'application/vnd.oci.image.index.v1+json',
						manifests: [
							{ digest: 'sha256:amd', platform: { architecture: 'amd64', os: 'linux' } },
							{ digest: 'sha256:arm', platform: { architecture: 'arm64', os: 'linux' } },
						],
					});
				}
				if (url.includes('sha256%3Aarm') || url.endsWith('/manifests/sha256:arm')) {
					return jsonResponse({
						layers: [{ size: 42 }],
					});
				}
				return jsonResponse({ layers: [{ size: 99 }] });
			},
		});
		assert.equal(size, 42);
	});

	it('returns undefined when the registry errors', async () => {
		const size = await lookupOllamaModelSize('missing', {
			fetchFn: async () => new Response('nope', { status: 404 }),
		});
		assert.equal(size, undefined);
	});
});

describe('pullOllamaModel', () => {
	it('aggregates per-digest progress and completes on success', async () => {
		const reports: Array<{ completed: number; total: number; status: string }> = [];
		await pullOllamaModel('http://127.0.0.1:11434', 'qwen2.5-coder:7b', {
			onProgress: p => reports.push({ ...p }),
			fetchFn: async () => streamResponse([
				{ status: 'pulling manifest' },
				{ status: 'downloading', digest: 'sha256:a', total: 100, completed: 40 },
				{ status: 'downloading', digest: 'sha256:b', total: 50, completed: 50 },
				{ status: 'downloading', digest: 'sha256:a', total: 100, completed: 100 },
				{ status: 'success' },
			]),
		});
		const last = reports.at(-1);
		assert.deepEqual(last, { completed: 150, total: 150, status: 'success' });
	});

	it('throws on a pull error event', async () => {
		await assert.rejects(
			() => pullOllamaModel('http://127.0.0.1:11434', 'nope', {
				fetchFn: async () => streamResponse([{ error: 'file does not exist' }]),
			}),
			/file does not exist/,
		);
	});
});

describe('ensureOllamaModelInstalled', () => {
	it('skips the prompt when the model is already local', async () => {
		let prompted = false;
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			listInstalled: async () => ['qwen2.5-coder:14b'],
			promptInstall: async () => {
				prompted = true;
				return true;
			},
		}));
		assert.deepEqual(result, { status: 'already-installed' });
		assert.equal(prompted, false);
	});

	it('pulls after the user accepts, passing the looked-up size into the prompt', async () => {
		const prompted: Array<{ model: string; sizeBytes: number | undefined }> = [];
		const reports: string[] = [];
		let pulled = false;
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			lookupSize: async () => 9 * 1024 ** 3,
			promptInstall: async (model, sizeBytes) => {
				prompted.push({ model, sizeBytes });
				return true;
			},
			pull: async (_baseUrl, _model, onProgress) => {
				pulled = true;
				onProgress({ completed: 1024 ** 3, total: 2 * 1024 ** 3, status: 'downloading' });
			},
			withProgress: async (_title, task) => task(message => reports.push(message), new AbortController().signal),
		}));
		assert.deepEqual(result, { status: 'installed' });
		assert.deepEqual(prompted, [{ model: 'qwen2.5-coder:14b', sizeBytes: 9 * 1024 ** 3 }]);
		assert.equal(pulled, true);
		assert.deepEqual(reports, ['downloading (1.0 GB / 2.0 GB)']);
	});

	it('does not pull when the user declines', async () => {
		let pulled = false;
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			promptInstall: async () => false,
			pull: async () => {
				pulled = true;
			},
		}));
		assert.deepEqual(result, { status: 'declined' });
		assert.equal(pulled, false);
	});

	it('returns unavailable when Ollama cannot be started', async () => {
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			ensureServer: async () => false,
		}));
		assert.deepEqual(result, { status: 'unavailable' });
	});

	it('returns cancelled when the pull is aborted', async () => {
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			promptInstall: async () => true,
			pull: async () => {
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			},
		}));
		assert.deepEqual(result, { status: 'cancelled' });
	});

	it('reports pull failures to the user', async () => {
		const errors: string[] = [];
		const result = await ensureOllamaModelInstalled('qwen2.5-coder:14b', 'http://127.0.0.1:11434', fakeEnsureDeps({
			promptInstall: async () => true,
			pull: async () => {
				throw new Error('disk full');
			},
			showError: message => {
				errors.push(message);
			},
		}));
		assert.deepEqual(result, { status: 'failed', message: 'disk full' });
		assert.equal(errors.length, 1);
		assert.match(errors[0], /disk full/);
	});
});

function fakeEnsureDeps(overrides: Partial<EnsureOllamaModelDeps> = {}): EnsureOllamaModelDeps {
	return {
		ensureServer: async () => true,
		listInstalled: async () => [],
		lookupSize: async () => undefined,
		pull: async () => { },
		promptInstall: async () => true,
		withProgress: async (_title, task) => task(() => { }, new AbortController().signal),
		showError: () => { },
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function streamResponse(events: object[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}
