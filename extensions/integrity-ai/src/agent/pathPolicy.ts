/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure path-policy helpers for Integrity agent tools (no vscode dependency).
 */

/** Common parameter names local models use instead of `path`. */
export const PATH_INPUT_ALIASES = ['path', 'filePath', 'file_path', 'filepath'] as const;

/**
 * Returns true when a relative path looks like an environment / secrets file.
 */
export function isSensitivePath(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	const base = normalized.split('/').pop() ?? normalized;
	return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

/**
 * Normalize path separators to POSIX `/`.
 */
export function posixifyFsPath(input: string): string {
	return input.replace(/\\/g, '/');
}

/**
 * True for Unix absolute paths and Windows drive-letter paths (after POSIX-ifying).
 */
export function isAbsoluteFsPath(input: string): boolean {
	const path = posixifyFsPath(input.trim());
	return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

/**
 * Strip a `file://` URI to a filesystem path when possible.
 */
export function stripFileUrl(input: string): string {
	const trimmed = input.trim();
	if (!/^file:/i.test(trimmed)) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'file:') {
			return trimmed;
		}
		let pathname = decodeURIComponent(url.pathname);
		// file:///C:/Users/... → /C:/Users/... on some parsers; drop the leading slash.
		if (/^\/[a-zA-Z]:\//.test(pathname)) {
			pathname = pathname.slice(1);
		}
		return pathname;
	} catch {
		return trimmed.replace(/^file:\/\//i, '');
	}
}

/**
 * If `absolutePath` is under a workspace root, return the workspace-relative POSIX path.
 * Returns `'.'` when the path is exactly a workspace root.
 */
export function relativizeToWorkspaceRoots(
	absolutePath: string,
	workspaceRoots: readonly string[],
): string | undefined {
	const abs = posixifyFsPath(stripFileUrl(absolutePath));
	for (const root of workspaceRoots) {
		const r = posixifyFsPath(root).replace(/\/+$/, '');
		if (!r) {
			continue;
		}
		const caseInsensitive = /^[a-zA-Z]:\//.test(r);
		const absCmp = caseInsensitive ? abs.toLowerCase() : abs;
		const rootCmp = caseInsensitive ? r.toLowerCase() : r;
		if (absCmp === rootCmp) {
			return '.';
		}
		if (absCmp.startsWith(rootCmp + '/')) {
			return abs.slice(r.length + 1);
		}
	}
	return undefined;
}

/**
 * Pull a path string from tool input, accepting common aliases.
 */
export function extractPathFromInput(input: unknown): {
	raw: string | undefined;
	usedKey: string | undefined;
	presentKeys: string[];
} {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { raw: undefined, usedKey: undefined, presentKeys: [] };
	}
	const obj = input as Record<string, unknown>;
	const presentKeys = Object.keys(obj);
	for (const key of PATH_INPUT_ALIASES) {
		const value = obj[key];
		if (typeof value === 'string' && value.trim()) {
			return { raw: value, usedKey: key, presentKeys };
		}
	}
	for (const key of PATH_INPUT_ALIASES) {
		if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'string') {
			return { raw: '', usedKey: key, presentKeys };
		}
	}
	return { raw: undefined, usedKey: undefined, presentKeys };
}

export type ResolveAgentPathResult =
	| { ok: true; path: string }
	| { ok: false; error: string; basenameLookup?: string };

/**
 * True for invented tutorial placeholders like `/path/to/main.py`.
 */
export function isPlaceholderPath(input: string): boolean {
	const path = posixifyFsPath(stripFileUrl(input)).toLowerCase();
	return (
		/(^|\/)path\/to(\/|$)/.test(path) ||
		/(^|\/)your[-_]?path(\/|$)/.test(path) ||
		/(^|\/)example(\/path)?(\/|$)/.test(path) ||
		/(^|\/)placeholder(\/|$)/.test(path) ||
		path.includes('/path/to/') ||
		path.includes('\\path\\to\\')
	);
}

/**
 * Basename of a path (POSIX), or undefined if empty / looks like a directory-only path.
 */
export function fileBasename(input: string): string | undefined {
	const path = posixifyFsPath(stripFileUrl(input)).replace(/\/+$/, '');
	const base = path.split('/').pop()?.trim();
	if (!base || base === '.' || base === '..') {
		return undefined;
	}
	return base;
}

/**
 * Whether an unresolved path should trigger a workspace basename search.
 */
export function shouldLookupBasenameInWorkspace(
	rawPath: string,
	workspaceRoots: readonly string[],
): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return undefined;
	}
	const base = fileBasename(trimmed);
	if (!base) {
		return undefined;
	}

	if (isPlaceholderPath(trimmed)) {
		return base;
	}

	if (isAbsoluteFsPath(trimmed) || /^file:/i.test(trimmed)) {
		if (!workspaceRoots.length || relativizeToWorkspaceRoots(trimmed, workspaceRoots) === undefined) {
			return base;
		}
	}

	return undefined;
}

/**
 * Choose a unique workspace-relative match for a basename lookup.
 */
export function pickUniqueBasenameMatch(
	basename: string,
	matches: readonly string[],
): ResolveAgentPathResult {
	const normalizedMatches = matches
		.map(m => normalizeWorkspaceRelativePath(m) ?? m.replace(/\\/g, '/'))
		.filter(Boolean);
	const exact = normalizedMatches.filter(m => {
		const b = fileBasename(m);
		return b !== undefined && b.toLowerCase() === basename.toLowerCase();
	});
	const pool = exact.length ? exact : normalizedMatches;

	if (pool.length === 1) {
		return { ok: true, path: pool[0] };
	}
	if (pool.length === 0) {
		return {
			ok: false,
			error:
				`No workspace file named "${basename}". ` +
				`Retry with path: "${basename}" to create/use it at the workspace root, or pass a workspace-relative path.`,
			basenameLookup: basename,
		};
	}
	return {
		ok: false,
		error:
			`Multiple workspace files named "${basename}": ${pool.slice(0, 12).join(', ')}. ` +
			'Retry with one of these exact workspace-relative paths. Do not ask the user.',
		basenameLookup: basename,
	};
}

/**
 * Resolve a tool path argument to a workspace-relative POSIX path.
 *
 * Accepts `path` / `filePath` / `file_path` / `filepath`. Absolute paths (and
 * `file://` URIs) under a workspace root are relativized; others are rejected
 * with an optional {@link ResolveAgentPathResult} `basenameLookup` hint so
 * callers can search the workspace.
 */
export function resolveAgentFilePath(
	input: unknown,
	workspaceRoots: readonly string[],
	opts?: { optional?: boolean; defaultPath?: string },
): ResolveAgentPathResult {
	const { raw, presentKeys } = extractPathFromInput(input);
	let candidate = raw;

	if (candidate === undefined || candidate === '') {
		if (opts?.optional || opts?.defaultPath !== undefined) {
			candidate = opts.defaultPath ?? '.';
		} else {
			const keysHint = presentKeys.length ? ` Got keys: ${presentKeys.join(', ')}.` : '';
			return {
				ok: false,
				error:
					'Missing required "path" (workspace-relative, e.g. main.py). ' +
					'Aliases accepted: path, filePath, file_path.' +
					keysHint,
			};
		}
	}

	candidate = candidate.trim();

	const lookup = shouldLookupBasenameInWorkspace(candidate, workspaceRoots);
	if (lookup) {
		return {
			ok: false,
			error:
				`Path "${candidate}" is not a usable workspace path` +
				(isPlaceholderPath(candidate) ? ' (placeholder like /path/to/... is not allowed)' : ' (outside the workspace)') +
				`. Search the workspace for "${lookup}" and retry with a workspace-relative path such as "${lookup}". Do not ask the user for the path.`,
			basenameLookup: lookup,
		};
	}

	if (isAbsoluteFsPath(candidate) || /^file:/i.test(candidate)) {
		if (!workspaceRoots.length) {
			return { ok: false, error: 'No workspace open; cannot resolve absolute paths.' };
		}
		const relative = relativizeToWorkspaceRoots(candidate, workspaceRoots);
		if (relative === undefined) {
			const base = fileBasename(candidate);
			return {
				ok: false,
				error:
					`Absolute path is outside the workspace: ${candidate}. ` +
					'Use a workspace-relative path (e.g. main.py or src/main.py).',
				basenameLookup: base,
			};
		}
		candidate = relative;
	}

	if (candidate === '.' || candidate === '') {
		return { ok: true, path: '.' };
	}

	const normalized = normalizeWorkspaceRelativePath(candidate);
	if (normalized === undefined) {
		const base = fileBasename(candidate);
		return {
			ok: false,
			error:
				`Invalid path "${candidate}": must be workspace-relative without .. traversal escaping the workspace. ` +
				'Example: main.py',
			basenameLookup: base,
		};
	}
	return { ok: true, path: normalized || '.' };
}

/**
 * Normalize a user-supplied path to a workspace-relative POSIX path.
 * Rejects absolute paths and `..` traversal that would escape the workspace.
 */
export function normalizeWorkspaceRelativePath(input: string): string | undefined {
	if (!input || !input.trim()) {
		return undefined;
	}
	let path = input.trim().replace(/\\/g, '/');
	if (path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) {
		return undefined;
	}
	const parts = path.split('/').filter(p => p.length > 0 && p !== '.');
	const stack: string[] = [];
	for (const part of parts) {
		if (part === '..') {
			if (stack.length === 0) {
				return undefined;
			}
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join('/');
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = 0;
	while (true) {
		const found = haystack.indexOf(needle, index);
		if (found < 0) {
			break;
		}
		count += 1;
		index = found + needle.length;
	}
	return count;
}

/**
 * Apply a unique search/replace. Fails if oldText is missing or appears more than once.
 */
export function applyUniqueReplace(
	content: string,
	oldText: string,
	newText: string,
): { ok: true; updated: string } | { ok: false; error: string } {
	if (!oldText) {
		return { ok: false, error: 'oldText must be non-empty for replace_string_in_file.' };
	}
	const count = countOccurrences(content, oldText);
	if (count === 0) {
		return { ok: false, error: 'oldText not found in file.' };
	}
	if (count > 1) {
		return { ok: false, error: `oldText matched ${count} times; must be unique. Narrow the match.` };
	}
	return { ok: true, updated: content.replace(oldText, newText) };
}

/**
 * A single JSON hunk for {@link applyPatchHunks}.
 * Empty/omitted `oldText` means append (or create when the file is missing).
 */
export interface PatchHunk {
	oldText?: string;
	newText: string;
}

export type NormalizePatchInputResult =
	| { ok: true; hunks: PatchHunk[] }
	| { ok: false; error: string };

function asHunk(value: unknown): PatchHunk | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	const newText =
		typeof obj.newText === 'string' ? obj.newText
			: typeof obj.content === 'string' ? obj.content
				: typeof obj.text === 'string' ? obj.text
					: undefined;
	if (newText === undefined) {
		return undefined;
	}
	const oldText =
		typeof obj.oldText === 'string' ? obj.oldText
			: typeof obj.old_text === 'string' ? obj.old_text
				: undefined;
	return oldText === undefined ? { newText } : { oldText, newText };
}

/**
 * Normalize local-model apply_patch arguments into hunks.
 *
 * Accepts:
 * - `hunks: [{ oldText?, newText }]`
 * - `patch` / `content` / `code` string → one append/create hunk
 * - top-level `oldText` + `newText`
 */
export function normalizePatchInput(input: unknown): NormalizePatchInputResult {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {
			ok: false,
			error:
				'Invalid apply_patch input. Provide hunks: [{ "newText": "..." }] to append/create, ' +
				'or hunks with oldText for unique replace. Aliases: patch/content (string) for append.',
		};
	}
	const obj = input as Record<string, unknown>;

	if (Array.isArray(obj.hunks)) {
		if (!obj.hunks.length) {
			return { ok: false, error: 'hunks must be a non-empty array.' };
		}
		const hunks: PatchHunk[] = [];
		for (let i = 0; i < obj.hunks.length; i++) {
			const hunk = asHunk(obj.hunks[i]);
			if (!hunk) {
				return { ok: false, error: `hunk ${i}: missing newText (or content/text).` };
			}
			hunks.push(hunk);
		}
		return { ok: true, hunks };
	}

	for (const key of ['patch', 'content', 'code', 'text'] as const) {
		const value = obj[key];
		if (typeof value === 'string' && value.length) {
			return { ok: true, hunks: [{ newText: value }] };
		}
	}

	const topLevel = asHunk(obj);
	if (topLevel && (typeof obj.newText === 'string' || typeof obj.content === 'string' || typeof obj.text === 'string')) {
		// Only treat as a top-level hunk when newText-like keys are present (avoid matching path-only objects).
		if ('oldText' in obj || 'old_text' in obj || 'newText' in obj || 'content' in obj || 'text' in obj) {
			return { ok: true, hunks: [topLevel] };
		}
	}

	const keys = Object.keys(obj).join(', ') || '(none)';
	return {
		ok: false,
		error:
			'Missing patch body. Pass hunks: [{ "newText": "<code to add>" }] to append/create, ' +
			'or patch: "<code to add>" (string alias). ' +
			`Got keys: ${keys}.`,
	};
}

/**
 * Ensure appended text starts on a new line when the existing file has content.
 */
export function prepareAppendNewText(existingContent: string | undefined, newText: string): string {
	if (existingContent === undefined || existingContent.length === 0) {
		return newText;
	}
	if (existingContent.endsWith('\n') || newText.startsWith('\n')) {
		return newText;
	}
	return '\n' + newText;
}

export type ApplyPatchHunksResult =
	| { ok: true; updated: string; created: boolean }
	| { ok: false; error: string };

/**
 * Apply ordered patch hunks to an optional existing file buffer.
 *
 * - Missing file + first hunk with empty oldText → create with newText.
 * - Existing file + empty oldText → append newText.
 * - Non-empty oldText → unique replace (fails with no partial apply of later hunks).
 */
export function applyPatchHunks(
	existingContent: string | undefined,
	hunks: readonly PatchHunk[],
): ApplyPatchHunksResult {
	if (!hunks.length) {
		return { ok: false, error: 'hunks must be a non-empty array.' };
	}

	const fileExists = existingContent !== undefined;
	let updated = existingContent ?? '';
	let created = false;

	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		const newText = typeof hunk?.newText === 'string' ? hunk.newText : '';
		const oldText = typeof hunk?.oldText === 'string' ? hunk.oldText : '';

		if (!oldText) {
			if (!fileExists && i === 0 && !created) {
				updated = newText;
				created = true;
				continue;
			}
			if (!fileExists && !created) {
				return { ok: false, error: `hunk ${i}: cannot append to a missing file; use empty oldText on the first hunk to create it.` };
			}
			updated = updated + prepareAppendNewText(updated, newText);
			continue;
		}

		if (!fileExists && !created) {
			return { ok: false, error: `hunk ${i}: file does not exist; use empty oldText on the first hunk to create it, or create the file first.` };
		}

		const replaced = applyUniqueReplace(updated, oldText, newText);
		if (!replaced.ok) {
			return { ok: false, error: `hunk ${i}: ${replaced.error}` };
		}
		updated = replaced.updated;
	}

	return { ok: true, updated, created };
}
