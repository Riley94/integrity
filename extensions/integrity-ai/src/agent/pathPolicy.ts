/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure path-policy helpers for Integrity agent tools (no vscode dependency).
 */

/**
 * Returns true when a relative path looks like an environment / secrets file.
 */
export function isSensitivePath(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	const base = normalized.split('/').pop() ?? normalized;
	return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
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
			updated = updated + newText;
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
