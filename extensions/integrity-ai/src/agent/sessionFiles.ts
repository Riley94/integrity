/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { normalizeWorkspaceRelativePath } from './pathPolicy';
import { EDIT_TOOLS } from './toolNames';

/**
 * Key on `ChatResult.metadata` for files this turn created or updated.
 * The next turn reads it back from each assistant history turn.
 */
export const SESSION_FILES_METADATA_KEY = 'integritySessionFiles';

/**
 * How many paths a later turn keeps. Older paths are dropped first.
 * A single chat can touch more files than the writer should re-read.
 */
export const SESSION_FILE_CAP = 30;

/**
 * How much of the previous user prompt is copied into the continuation task.
 * Jev clips the whole task again; this keeps the new prompt and the file list in view.
 */
export const PREVIOUS_USER_PROMPT_CLIP = 2000;

/** Whether the first successful write of a path created it or changed an existing file. */
export type SessionFileAction = 'created' | 'updated';

/** One workspace-relative path the agent wrote during a chat. */
export interface SessionFileRecord {
	readonly path: string;
	readonly action: SessionFileAction;
}

/** A prior chat turn, stripped of VS Code types so the union can be tested alone. */
export interface SessionHistoryTurn {
	readonly kind: 'user' | 'assistant';
	/** User prompt. Empty for assistant turns. */
	readonly prompt?: string;
	/** Assistant `ChatResult.metadata`. Empty for user turns. */
	readonly metadata?: unknown;
}

/**
 * Record a successful create, unique replace, or patch.
 * Failures, cancellations, reads, and other tools leave `files` unchanged.
 * A path that was created stays `created` if this turn later updates it.
 * The path is the workspace-relative path from the tool result (`Created` / `Updated`).
 */
export function noteSessionWrite(
	files: readonly SessionFileRecord[],
	toolName: string,
	resultText: string,
): readonly SessionFileRecord[] {
	if (!EDIT_TOOLS.has(toolName)) {
		return files;
	}
	const written = sessionFileFromEditSuccess(resultText.trim());
	if (!written) {
		return files;
	}
	return mergeSessionFile(files, written);
}

/**
 * Files to put on `ChatResult.metadata` for this turn.
 * An empty list is omitted so a turn that did not write stores nothing.
 */
export function sessionFilesResult(
	files: readonly SessionFileRecord[],
): { metadata?: { readonly [key: string]: readonly SessionFileRecord[] } } {
	if (!files.length) {
		return {};
	}
	return {
		metadata: {
			[SESSION_FILES_METADATA_KEY]: files.map(file => ({ path: file.path, action: file.action })),
		},
	};
}

/**
 * Union file lists from assistant turns, in history order.
 * A path that was created stays `created` when a later turn only updates it.
 * Past {@link SESSION_FILE_CAP}, the oldest paths are dropped.
 * User turns and missing or malformed metadata contribute nothing.
 */
export function unionSessionFiles(
	turns: readonly { metadata?: unknown }[],
	cap: number = SESSION_FILE_CAP,
): SessionFileRecord[] {
	let files: readonly SessionFileRecord[] = [];
	for (const turn of turns) {
		for (const file of readSessionFiles(turn.metadata)) {
			files = mergeSessionFile(files, file);
		}
	}
	if (cap < 0 || files.length <= cap) {
		return [...files];
	}
	return files.slice(files.length - cap);
}

/**
 * The latest user prompt in `turns`. The current request is not part of history,
 * so this is the message the follow-up is answering.
 */
export function previousUserPrompt(turns: readonly SessionHistoryTurn[]): string {
	for (let i = turns.length - 1; i >= 0; i--) {
		const turn = turns[i];
		if (turn.kind === 'user' && turn.prompt?.trim()) {
			return turn.prompt;
		}
	}
	return '';
}

/**
 * Task text for tool choice and codebase search.
 * With no files from earlier turns, this is `prompt` unchanged.
 * Otherwise it adds the previous user prompt and the paths already written,
 * so a follow-up such as "implement that" still names the app.
 */
export function continuationTask(
	prompt: string,
	previousPrompt: string,
	files: readonly SessionFileRecord[],
): string {
	if (!files.length) {
		return prompt;
	}
	const parts = [prompt.trimEnd()];
	const earlier = previousPrompt.trim();
	if (earlier) {
		parts.push('', 'Earlier in this chat the user asked:', clip(earlier, PREVIOUS_USER_PROMPT_CLIP));
	}
	parts.push('', 'Files already changed in this chat:');
	for (const file of files) {
		parts.push(`- ${file.path} (${file.action})`);
	}
	return parts.join('\n');
}

/**
 * `Created` / `Updated` are the success lines from the file tools.
 * Anything else (already exists, not found, cancelled, patch rejected) is not a write.
 */
function sessionFileFromEditSuccess(resultText: string): SessionFileRecord | undefined {
	const match = /^(Created|Updated) (\S(?:.*\S)?)$/.exec(resultText);
	if (!match) {
		return undefined;
	}
	const path = normalizeWorkspaceRelativePath(match[2]);
	if (!path) {
		return undefined;
	}
	return { path, action: match[1] === 'Created' ? 'created' : 'updated' };
}

function readSessionFiles(metadata: unknown): SessionFileRecord[] {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return [];
	}
	const raw = (metadata as Record<string, unknown>)[SESSION_FILES_METADATA_KEY];
	if (!Array.isArray(raw)) {
		return [];
	}
	const files: SessionFileRecord[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.path !== 'string' || (record.action !== 'created' && record.action !== 'updated')) {
			continue;
		}
		const path = normalizeWorkspaceRelativePath(record.path);
		if (!path) {
			continue;
		}
		files.push({ path, action: record.action });
	}
	return files;
}

/**
 * Insert `file`, or keep an existing `created` action when a later write only updates that path.
 * A later `created` upgrades an `updated` entry (the file was replaced).
 * First-seen order is kept so the cap drops the oldest paths.
 */
function mergeSessionFile(
	files: readonly SessionFileRecord[],
	file: SessionFileRecord,
): readonly SessionFileRecord[] {
	const index = files.findIndex(existing => existing.path === file.path);
	if (index < 0) {
		return [...files, file];
	}
	const existing = files[index];
	if (existing.action === 'created' || existing.action === file.action) {
		return files;
	}
	const next = files.slice();
	next[index] = { path: file.path, action: 'created' };
	return next;
}

function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, max) + '…';
}
