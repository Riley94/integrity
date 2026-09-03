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
