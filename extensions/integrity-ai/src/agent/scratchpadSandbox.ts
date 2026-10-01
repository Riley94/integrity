/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { readdir, readlink } from 'fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'path';

/**
 * Launcher for the scratchpad sandbox. Production uses bubblewrap.
 * A missing launcher fails the run; the snippet is never executed on the host.
 */
export const SCRATCHPAD_SANDBOX_LAUNCHER = 'bwrap';

export interface ScratchpadSandboxLaunch {
	/** Absolute interpreter path inside the sandbox. */
	python: string;
	/** Read-only files and directories to mount at the same path. */
	readOnlyMounts: readonly string[];
	/** Environment visible to the snippet. Host variables are not included. */
	env: NodeJS.ProcessEnv;
	/** `bwrap` argument vector, including the launcher name. */
	args: string[];
}

/**
 * Environment inside the sandbox.
 * Only the scratch directory, the interpreter, and an optional virtual environment are named.
 * The host environment is not copied, so secrets and `PYTHONPATH` cannot leak in.
 */
export function scratchpadProcessEnv(
	scratchDir: string,
	pythonExecutable: string,
	virtualEnv?: string,
): NodeJS.ProcessEnv {
	const pythonBin = dirname(pythonExecutable);
	const env: NodeJS.ProcessEnv = {
		PATH: pythonBin,
		HOME: scratchDir,
		TMPDIR: scratchDir,
		PYTHONUNBUFFERED: '1',
		PYTHONDONTWRITEBYTECODE: '1',
		PYTHONNOUSERSITE: '1',
		LANG: 'C.UTF-8',
	};
	if (virtualEnv) {
		const venvBin = join(virtualEnv, 'bin');
		env.VIRTUAL_ENV = virtualEnv;
		env.PATH = pythonBin === venvBin ? venvBin : `${venvBin}${delimiter}${pythonBin}`;
	}
	return env;
}

/**
 * Drop mounts that sit inside an earlier mount. Bubblewrap rejects the overlap,
 * and the parent directory already provides the child.
 * The filesystem root is never a mount.
 */
export function pruneNestedMounts(mounts: readonly string[]): string[] {
	const sorted = [...new Set(mounts.map(mount => resolve(mount)))].filter(mount => mount !== sep);
	sorted.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
	const kept: string[] = [];
	for (const mount of sorted) {
		const covered = kept.some(parent => mount === parent || mount.startsWith(parent + sep));
		if (!covered) {
			kept.push(mount);
		}
	}
	return kept;
}

/**
 * Bubblewrap command for one snippet.
 * The mount namespace starts empty. Runtime files are read-only. The scratch directory is the
 * only writable path, and it is bound after `/tmp` is replaced so the host's other temp files stay hidden.
 * `--unshare-all` drops the network and the host process, user, and IPC namespaces.
 */
export function bubblewrapArgs(options: {
	bwrap: string;
	python: string;
	script: string;
	scratchDir: string;
	readOnlyMounts: readonly string[];
	env: NodeJS.ProcessEnv;
}): string[] {
	const args = [
		options.bwrap,
		'--unshare-all',
		'--die-with-parent',
		'--new-session',
		'--hostname', 'integrity-scratchpad',
		'--proc', '/proc',
		'--dev', '/dev',
		'--tmpfs', '/tmp',
	];
	for (const mount of pruneNestedMounts(options.readOnlyMounts)) {
		args.push('--ro-bind', mount, mount);
	}
	args.push('--bind', options.scratchDir, options.scratchDir, '--chdir', options.scratchDir, '--clearenv');
	for (const [key, value] of Object.entries(options.env)) {
		if (value !== undefined) {
			args.push('--setenv', key, value);
		}
	}
	args.push('--', options.python, '-P', options.script);
	return args;
}

interface RuntimeLayout {
	executable: string;
	realpath: string;
	stdlib: string;
}

const mountCache = new Map<string, string[]>();

/**
 * Read-only mounts for this interpreter.
 * The standard library and the selected virtual environment are imported into the sandbox.
 * A workspace path is included only when it is that virtual environment, or a single shared
 * library that environment links to. The rest of the workspace is not mounted.
 */
export async function collectReadOnlyMounts(
	python: string,
	workspaceRoots: readonly string[] = [],
	virtualEnv?: string,
): Promise<string[]> {
	const layout = await readRuntimeLayout(python);
	const cacheKey = `${layout.realpath}\0${virtualEnv ?? ''}`;
	const cached = mountCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const directories = [layout.stdlib];
	if (virtualEnv) {
		directories.push(virtualEnv);
	}
	const extensions = [
		...await nativeExtensions(join(layout.stdlib, 'lib-dynload')),
	];
	if (virtualEnv) {
		extensions.push(...await nativeExtensions(virtualEnv));
	}
	const libraries = await sharedLibraries([layout.realpath, ...extensions]);
	const files = [
		...await symlinkChain(layout.executable),
		...await symlinkChains(libraries),
	];

	const mounts: string[] = [];
	for (const dir of directories) {
		if (mountAllowed(dir, workspaceRoots, virtualEnv, 'dir')) {
			mounts.push(resolve(dir));
		}
	}
	for (const file of files) {
		if (mountAllowed(file, workspaceRoots, virtualEnv, 'file')) {
			mounts.push(resolve(file));
		}
	}

	const pruned = pruneNestedMounts(mounts);
	if (!pruned.length) {
		throw new Error('Scratchpad isolation could not find a Python runtime to import.');
	}
	mountCache.set(cacheKey, pruned);
	return pruned;
}

/**
 * Build the sandbox launch for one snippet.
 * Fails when bubblewrap or the runtime layout cannot be prepared. The caller must not spawn Python unsandboxed.
 */
export async function prepareScratchpadSandbox(options: {
	python: string;
	script: string;
	scratchDir: string;
	workspaceRoots?: readonly string[];
	virtualEnv?: string;
	bwrap?: string;
}): Promise<ScratchpadSandboxLaunch> {
	const readOnlyMounts = await collectReadOnlyMounts(
		options.python,
		options.workspaceRoots ?? [],
		options.virtualEnv,
	);
	const layout = await readRuntimeLayout(options.python);
	const env = scratchpadProcessEnv(options.scratchDir, layout.executable, options.virtualEnv);
	const bwrap = options.bwrap ?? SCRATCHPAD_SANDBOX_LAUNCHER;
	return {
		python: layout.executable,
		readOnlyMounts,
		env,
		args: bubblewrapArgs({
			bwrap,
			python: layout.executable,
			script: options.script,
			scratchDir: options.scratchDir,
			readOnlyMounts,
			env,
		}),
	};
}

/**
 * A workspace path may be mounted only as the selected virtual environment, or as one
 * shared library that environment needs. The workspace root itself is never mounted.
 */
function mountAllowed(
	path: string,
	workspaceRoots: readonly string[],
	virtualEnv: string | undefined,
	kind: 'dir' | 'file',
): boolean {
	const resolved = resolve(path);
	if (resolved === sep) {
		return false;
	}
	for (const root of workspaceRoots) {
		const workspace = resolve(root);
		const inWorkspace = resolved === workspace || resolved.startsWith(workspace + sep);
		if (!inWorkspace) {
			continue;
		}
		if (virtualEnv) {
			const venv = resolve(virtualEnv);
			if (resolved === venv || resolved.startsWith(venv + sep)) {
				return true;
			}
		}
		return kind === 'file';
	}
	return true;
}

const layoutCache = new Map<string, RuntimeLayout>();

async function readRuntimeLayout(python: string): Promise<RuntimeLayout> {
	const cached = layoutCache.get(python);
	if (cached) {
		return cached;
	}
	const script = [
		'import json, os, sys, sysconfig',
		'print(json.dumps({',
		'"executable": sys.executable,',
		'"realpath": os.path.realpath(sys.executable),',
		'"stdlib": sysconfig.get_path("stdlib"),',
		'}))',
	].join('\n');
	const stdout = await capture(python, ['-c', script], { PATH: process.env.PATH });
	let parsed: RuntimeLayout;
	try {
		parsed = JSON.parse(stdout) as RuntimeLayout;
	} catch {
		throw new Error('Scratchpad isolation could not read the Python runtime layout.');
	}
	if (!parsed.executable || !parsed.stdlib) {
		throw new Error('Scratchpad isolation could not read the Python runtime layout.');
	}
	layoutCache.set(python, parsed);
	return parsed;
}

/**
 * Every path in a symlink chain, including the final file.
 * A virtualenv `python` points at `python3`, which points at `/usr/bin/python3`.
 * Each hop has to be mounted or exec fails inside the empty namespace.
 */
async function symlinkChain(path: string): Promise<string[]> {
	const chain: string[] = [];
	let current = resolve(path);
	const seen = new Set<string>();
	while (!seen.has(current)) {
		seen.add(current);
		chain.push(current);
		let link: string;
		try {
			link = await readlink(current);
		} catch {
			break;
		}
		current = resolve(dirname(current), link);
	}
	return chain;
}

async function symlinkChains(paths: readonly string[]): Promise<string[]> {
	const chains = await Promise.all(paths.map(path => symlinkChain(path)));
	return chains.flat();
}

async function nativeExtensions(dir: string): Promise<string[]> {
	const found: string[] = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop()!;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.includes('.so')) {
				found.push(full);
			}
		}
	}
	return found;
}

async function sharedLibraries(files: readonly string[]): Promise<string[]> {
	const libs = new Set<string>();
	await Promise.all(files.map(async file => {
		let output = '';
		try {
			output = await capture('ldd', [file], { PATH: process.env.PATH });
		} catch {
			return;
		}
		for (const match of output.matchAll(/(\/\S+)/g)) {
			const path = match[1];
			if (path) {
				libs.add(path);
			}
		}
	}));
	return [...libs];
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', reject);
		child.on('close', code => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `${command} exited ${code}`));
				return;
			}
			resolveOutput(stdout.trim());
		});
	});
}
