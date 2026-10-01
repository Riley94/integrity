/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { constants } from 'fs';
import { access, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, join, resolve, sep } from 'path';

/** Wall-clock limit for one snippet. Long enough to compute, short enough to fail closed. */
export const SCRATCHPAD_TIMEOUT_MS = 30_000;

/** Cap on stdout and on stderr, so a noisy snippet cannot flood the next model step. */
export const SCRATCHPAD_MAX_OUTPUT_CHARS = 20_000;

/** Reject snippets larger than this before spawning Python. */
export const SCRATCHPAD_MAX_CODE_CHARS = 100_000;

const PREVIEW_LIMIT = 180;

export interface ScratchpadResult {
	/** Interpreter that ran the snippet. Empty when the run never started. */
	python: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	truncated: boolean;
}

export interface RunPythonScratchpadOptions {
	code: string;
	/**
	 * Workspace roots. The first root that contains `.venv` or `venv` supplies the interpreter,
	 * so packages installed there can be imported. Every root is still removed from PYTHONPATH,
	 * so the project itself stays off sys.path.
	 */
	workspaceRoots?: readonly string[];
	timeoutMs?: number;
	maxOutputChars?: number;
	/** Interpreter to spawn. Production resolves `python3`/`python`; tests inject one. */
	pythonCommand?: string;
	baseEnv?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

/** Directory names probed, in order, at each workspace root. `.venv` wins over `venv`. */
const WORKSPACE_VENV_DIRS = ['.venv', 'venv'] as const;

let cachedSystemPython: string | undefined;

/**
 * Confirmation text for a scratchpad call. The snippet is clipped so the dialog stays readable.
 */
export function scratchpadApprovalPreview(code: string): string {
	const trimmed = code.trim();
	if (!trimmed) {
		return 'Run Python scratchpad?';
	}
	const body = trimmed.length > PREVIEW_LIMIT
		? trimmed.slice(0, PREVIEW_LIMIT) + '…'
		: trimmed;
	return `Run Python scratchpad?\n${body}`;
}

/**
 * Environment for a scratchpad process.
 * The workspace is stripped from PYTHONPATH, and PYTHONSTARTUP is dropped so a startup hook
 * cannot put the project back on sys.path. The interpreter's own site-packages stay available,
 * which is how a workspace virtual environment exposes installed packages.
 * PYTHONUNBUFFERED is set so a timeout still captures prints.
 */
export function scratchpadEnv(
	workspaceRoots: readonly string[],
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...baseEnv, PYTHONUNBUFFERED: '1' };
	delete env.PYTHONSTARTUP;
	const pythonPath = env.PYTHONPATH;
	if (pythonPath === undefined) {
		return env;
	}
	const roots = workspaceRoots.map(root => resolve(root));
	const kept = pythonPath.split(delimiter).filter(entry => {
		if (!entry) {
			return false;
		}
		const resolved = resolve(entry);
		return !roots.some(root => resolved === root || resolved.startsWith(root + sep));
	});
	if (kept.length) {
		env.PYTHONPATH = kept.join(delimiter);
	} else {
		delete env.PYTHONPATH;
	}
	return env;
}

/**
 * Run one Python snippet and return a model-facing transcript of the result.
 * An empty snippet, a missing interpreter, or a spawn error is a tool result, not a throw.
 */
export async function executeScratchpad(options: RunPythonScratchpadOptions): Promise<string> {
	const code = options.code ?? '';
	if (!code.trim()) {
		return 'Empty snippet.';
	}
	if (code.length > SCRATCHPAD_MAX_CODE_CHARS) {
		return `Snippet is too long (${code.length} characters). Limit is ${SCRATCHPAD_MAX_CODE_CHARS}.`;
	}
	try {
		const result = await runPythonScratchpad(options);
		return formatScratchpadResult(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `Scratchpad failed: ${message}`;
	}
}

/**
 * Format a finished run. The model reads this on the next step.
 */
export function formatScratchpadResult(result: ScratchpadResult): string {
	const lines = [`exit_code: ${result.exitCode === null ? 'null' : String(result.exitCode)}`];
	if (result.timedOut) {
		lines.push('timed_out: true');
	}
	if (result.cancelled) {
		lines.push('cancelled: true');
	}
	if (result.truncated) {
		lines.push('truncated: true');
	}
	if (result.python) {
		lines.push(`python: ${result.python}`);
	}
	lines.push('stdout:', result.stdout, 'stderr:', result.stderr);
	return lines.join('\n');
}

/**
 * Execute `code` with `python -P` in a temporary directory, then delete that directory.
 * `-P` keeps the script directory and cwd off sys.path (Python 3.11+). Combined with
 * {@link scratchpadEnv}, the workspace is not importable. A workspace `.venv` or `venv`
 * is still the interpreter, so its site-packages are.
 */
export async function runPythonScratchpad(options: RunPythonScratchpadOptions): Promise<ScratchpadResult> {
	if (options.signal?.aborted) {
		return cancelledResult();
	}
	const dir = await mkdtemp(join(tmpdir(), 'integrity-scratchpad-'));
	try {
		const script = join(dir, 'snippet.py');
		await writeFile(script, options.code, 'utf8');
		const python = options.pythonCommand ?? await resolvePythonCommand(options.workspaceRoots ?? []);
		return await spawnPython(python, script, dir, options);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Interpreter paths for one workspace root: `.venv` first, then `venv`.
 * On Unix each directory contributes `bin/python` then `bin/python3`.
 * The path is not realpath'd; resolving the symlink would drop the virtual environment.
 */
export function workspacePythonCandidates(workspaceRoot: string): string[] {
	const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
	const names = process.platform === 'win32' ? ['python.exe'] : ['python', 'python3'];
	const candidates: string[] = [];
	for (const dir of WORKSPACE_VENV_DIRS) {
		for (const name of names) {
			candidates.push(join(workspaceRoot, dir, bin, name));
		}
	}
	return candidates;
}

/**
 * Root of a workspace virtual environment when `pythonPath` is its interpreter.
 * Other interpreters, including `/usr/bin/python3`, return undefined.
 */
export function virtualEnvRoot(pythonPath: string): string | undefined {
	const parts = resolve(pythonPath).split(sep);
	const command = parts.at(-1);
	const bin = parts.at(-2);
	const folder = parts.at(-3);
	const windows = command === 'python.exe' && bin === 'Scripts';
	const unix = (command === 'python' || command === 'python3') && bin === 'bin';
	if ((!windows && !unix) || (folder !== '.venv' && folder !== 'venv')) {
		return undefined;
	}
	return parts.slice(0, -2).join(sep) || sep;
}

/**
 * Find a Python 3.11+ binary that accepts `-P`.
 * The first workspace root with a usable `.venv` or `venv` wins, so installed packages import.
 * Otherwise the system `python3`/`python` is used. A failed system lookup is not cached.
 */
export async function resolvePythonCommand(workspaceRoots: readonly string[] = []): Promise<string> {
	for (const root of workspaceRoots) {
		for (const candidate of workspacePythonCandidates(root)) {
			if (await isExecutable(candidate) && await pythonSupportsSafePath(candidate)) {
				return candidate;
			}
		}
	}
	if (cachedSystemPython) {
		return cachedSystemPython;
	}
	const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
	for (const command of candidates) {
		if (await pythonSupportsSafePath(command)) {
			cachedSystemPython = command;
			return command;
		}
	}
	throw new Error('Python 3.11+ is required for the scratchpad (python -P).');
}

function isExecutable(path: string): Promise<boolean> {
	return access(path, constants.X_OK).then(() => true, () => false);
}

function pythonSupportsSafePath(command: string): Promise<boolean> {
	return new Promise(resolveSupport => {
		const child = spawn(command, ['-P', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
			stdio: 'ignore',
		});
		child.on('error', () => resolveSupport(false));
		child.on('close', code => resolveSupport(code === 0));
	});
}

function spawnPython(
	python: string,
	script: string,
	cwd: string,
	options: RunPythonScratchpadOptions,
): Promise<ScratchpadResult> {
	const timeoutMs = options.timeoutMs ?? SCRATCHPAD_TIMEOUT_MS;
	const maxOutputChars = options.maxOutputChars ?? SCRATCHPAD_MAX_OUTPUT_CHARS;
	const env = scratchpadEnv(options.workspaceRoots ?? [], options.baseEnv);
	const virtualEnv = virtualEnvRoot(python);
	if (virtualEnv) {
		env.VIRTUAL_ENV = virtualEnv;
	}

	return new Promise((resolveResult, reject) => {
		let stdout = '';
		let stderr = '';
		let truncated = false;
		let timedOut = false;
		let cancelled = false;
		let settled = false;

		const child = spawn(python, ['-P', script], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		const finish = (result: ScratchpadResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			resolveResult(result);
		};

		const onAbort = () => {
			cancelled = true;
			child.kill('SIGKILL');
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener('abort', onAbort, { once: true });
			}
		}

		const append = (current: string, chunk: Buffer): string => {
			if (current.length >= maxOutputChars) {
				truncated = true;
				return current;
			}
			const next = current + chunk.toString('utf8');
			if (next.length > maxOutputChars) {
				truncated = true;
				return next.slice(0, maxOutputChars);
			}
			return next;
		};

		const take = (current: string, chunk: Buffer): string => {
			const next = append(current, chunk);
			if (truncated) {
				child.kill('SIGKILL');
			}
			return next;
		};

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout = take(stdout, chunk);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = take(stderr, chunk);
		});
		child.on('error', err => {
			// kill() reports ESRCH when the process has already exited. That is not a failed run.
			if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
				return;
			}
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			reject(err);
		});
		child.on('close', code => {
			finish({
				python,
				stdout,
				stderr,
				exitCode: timedOut || cancelled ? null : code,
				timedOut,
				cancelled,
				truncated,
			});
		});
	});
}

function cancelledResult(): ScratchpadResult {
	return {
		python: '',
		stdout: '',
		stderr: 'Cancelled.',
		exitCode: null,
		timedOut: false,
		cancelled: true,
		truncated: false,
	};
}
