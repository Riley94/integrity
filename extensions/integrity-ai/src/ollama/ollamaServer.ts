/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { homedir as osHomedir } from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_MS = 300;

/**
 * Well-known install locations used when `ollama` is not on PATH.
 * GUI-launched IDEs often inherit a stripped PATH that omits ~/.local/bin.
 */
export function commonOllamaPaths(platform: NodeJS.Platform = process.platform, home: string = osHomedir(), env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === 'win32') {
		const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
		const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
		return [
			path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
			path.join(programFiles, 'Ollama', 'ollama.exe'),
		];
	}

	return [
		path.join(home, '.local', 'bin', 'ollama'),
		'/usr/local/bin/ollama',
		'/usr/bin/ollama',
		'/opt/homebrew/bin/ollama',
		'/opt/ollama/bin/ollama',
	];
}

/**
 * True when `baseUrl` points at a server this machine can start.
 * Remote hosts cannot be launched from the IDE.
 */
export function isLocalOllamaUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`);
		const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
	} catch {
		return false;
	}
}

/**
 * `OLLAMA_HOST` value (`host:port`) so a spawned server binds the configured URL.
 */
export function hostEnvFromBaseUrl(baseUrl: string): string {
	const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`);
	const host = url.hostname || '127.0.0.1';
	const port = url.port || DEFAULT_OLLAMA_PORT;
	return `${host}:${port}`;
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/$/, '');
}

export async function probeOllama(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
	const url = `${normalizeOllamaBaseUrl(baseUrl)}/api/tags`;
	try {
		const response = await fetchFn(url);
		return response.ok;
	} catch {
		return false;
	}
}

export interface FindOllamaBinaryOptions {
	exists?: (candidate: string) => Promise<boolean>;
	lookupPath?: () => Promise<string | undefined>;
	homedir?: () => string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Ollama CLI: PATH first, then platform-specific install locations.
 */
export async function findOllamaBinary(options: FindOllamaBinaryOptions = {}): Promise<string | undefined> {
	const exists = options.exists ?? pathExists;
	const lookupPath = options.lookupPath ?? lookupOllamaOnPath;
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = options.homedir ?? osHomedir;

	const fromPath = await lookupPath();
	if (fromPath && await exists(fromPath)) {
		return fromPath;
	}

	for (const candidate of commonOllamaPaths(platform, home(), env)) {
		if (await exists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

export interface OllamaServerDeps {
	probe: (baseUrl: string) => Promise<boolean>;
	findBinary: () => Promise<string | undefined>;
	startProcess: (binary: string, env: NodeJS.ProcessEnv) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
}

export type EnsureOllamaResult =
	| { status: 'already-running' }
	| { status: 'started' }
	| { status: 'not-local'; baseUrl: string }
	| { status: 'not-installed' }
	| { status: 'start-failed'; message: string }
	| { status: 'timed-out' };

export interface EnsureOllamaOptions {
	timeoutMs?: number;
	pollMs?: number;
}

/**
 * Probe the configured Ollama URL and, when it is local and down, start `ollama serve`.
 */
export async function ensureOllamaRunning(
	baseUrl: string,
	deps: OllamaServerDeps,
	options: EnsureOllamaOptions = {},
): Promise<EnsureOllamaResult> {
	const normalized = normalizeOllamaBaseUrl(baseUrl);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const now = deps.now ?? Date.now;

	if (await deps.probe(normalized)) {
		return { status: 'already-running' };
	}

	if (!isLocalOllamaUrl(normalized)) {
		return { status: 'not-local', baseUrl: normalized };
	}

	const binary = await deps.findBinary();
	if (!binary) {
		return { status: 'not-installed' };
	}

	try {
		await deps.startProcess(binary, {
			OLLAMA_HOST: hostEnvFromBaseUrl(normalized),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { status: 'start-failed', message };
	}

	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		if (await deps.probe(normalized)) {
			return { status: 'started' };
		}
		await deps.sleep(pollMs);
	}

	return { status: 'timed-out' };
}

/**
 * Default process / filesystem adapters used by the IDE command.
 */
export function createDefaultOllamaDeps(): OllamaServerDeps {
	return {
		probe: (baseUrl) => probeOllama(baseUrl),
		findBinary: () => findOllamaBinary(),
		startProcess: spawnOllamaServe,
		sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
	};
}

/**
 * Start `ollama serve` detached so it outlives the command (and typically the IDE).
 */
export function spawnOllamaServe(binary: string, extraEnv: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const child = spawn(binary, ['serve'], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				env: { ...process.env, ...extraEnv },
			});
			let settled = false;
			child.once('error', (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			child.unref();
			setImmediate(() => {
				if (!settled) {
					settled = true;
					resolve();
				}
			});
		} catch (err) {
			reject(err);
		}
	});
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await access(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function lookupOllamaOnPath(): Promise<string | undefined> {
	const command = process.platform === 'win32' ? 'where' : 'which';
	const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
	try {
		const { stdout } = await execFileAsync(command, [exe]);
		const first = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
		return first;
	} catch {
		return undefined;
	}
}
