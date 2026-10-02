/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { extractPathFromInput, normalizeWorkspaceRelativePath } from './pathPolicy';
import { EDIT_TOOLS, IntegrityToolName } from './toolNames';

/**
 * How many times a turn will stop and ask the writer to re-read its edits.
 * Each pass covers the files still unread since the last edit. A later edit
 * starts another pass until this cap is reached.
 */
export const MAX_EDIT_REVIEWS = 3;

/** Files written this turn that have not been read since that write. */
export interface EditReviewState {
	/** Workspace-relative paths, in the order they were first written. */
	readonly unread: readonly string[];
	/** Review prompts already sent this turn. */
	readonly reviews: number;
}

export function emptyEditReviewState(): EditReviewState {
	return { unread: [], reviews: 0 };
}

/**
 * True when a text reply must not finish the turn: something was written,
 * it has not been read since, and the review cap is still open.
 */
export function editReviewPending(state: EditReviewState): boolean {
	return state.unread.length > 0 && state.reviews < MAX_EDIT_REVIEWS;
}

/** What to do with a text-only assistant reply that would otherwise end the turn. */
export type EditReviewDecision =
	| { action: 'exit' }
	| { action: 'continue'; message: string; state: EditReviewState };

/**
 * Hold a text reply while files the writer created or changed are still unread.
 * `canRead` is false when this turn cannot offer {@link IntegrityToolName.ReadFile}
 * (Ask mode never writes; a catalog that omitted the read tool cannot review).
 * Each hold counts as one review. After {@link MAX_EDIT_REVIEWS} holds, the reply ends the turn.
 */
export function holdReplyForEditReview(state: EditReviewState, canRead: boolean): EditReviewDecision {
	if (!canRead || !editReviewPending(state)) {
		return { action: 'exit' };
	}
	return {
		action: 'continue',
		message: editReviewMessage(state.unread),
		state: { unread: state.unread, reviews: state.reviews + 1 },
	};
}

/**
 * Instruction for the next step. Names the read tool and the paths still unread
 * so the writer reviews those edits instead of repeating its summary.
 */
export function editReviewMessage(paths: readonly string[]): string {
	const listed = paths.join('\n');
	return 'Read these files with integrity_read_file and review your edits before answering. Fix anything that does not match the request by calling integrity_apply_patch or integrity_replace_string. Do not print the call as JSON. If you change a file, review that edit too. Your previous summary was not shown; after the review, answer the user.\n' + listed;
}

/**
 * Keep the edit tools available so a review can fix a file it just wrote.
 * Jev may have kept only the tool that created the file. A catalog that omitted
 * an edit tool is unchanged. Returns `selected` itself when nothing is added.
 */
export function withReviewEditTools<T extends { name: string }>(selected: readonly T[], catalog: readonly T[]): readonly T[] {
	const missing = catalog.filter(tool => EDIT_TOOLS.has(tool.name) && !selected.some(item => item.name === tool.name));
	if (!missing.length) {
		return selected;
	}
	return [...selected, ...missing];
}

/**
 * Keep {@link IntegrityToolName.ReadFile} available so a review step can open the files it wrote.
 * A catalog that omitted the read tool is unchanged.
 * Returns `selected` itself when nothing is added.
 */
export function withReviewReadTool<T extends { name: string }>(selected: readonly T[], catalog: readonly T[]): readonly T[] {
	if (selected.some(tool => tool.name === IntegrityToolName.ReadFile)) {
		return selected;
	}
	const read = catalog.find(tool => tool.name === IntegrityToolName.ReadFile);
	if (!read) {
		return selected;
	}
	return [...selected, read];
}

/**
 * Record a settled tool call.
 * A successful create, unique replace, or patch adds the file to {@link EditReviewState.unread}.
 * A successful read of that path removes it. Failures leave the set alone.
 * The edit path comes from the tool result (`Created` / `Updated`), which is the path actually written.
 * The read path comes from the call input, which is what the review message asked the writer to open.
 */
export function noteToolResult(
	state: EditReviewState,
	toolName: string,
	input: unknown,
	resultText: string,
): EditReviewState {
	const text = resultText.trim();
	if (EDIT_TOOLS.has(toolName)) {
		const written = pathFromEditSuccess(text);
		if (!written) {
			return state;
		}
		if (state.unread.includes(written)) {
			return state;
		}
		return { ...state, unread: [...state.unread, written] };
	}
	if (toolName !== IntegrityToolName.ReadFile || !readSucceeded(text)) {
		return state;
	}
	const read = canonicalRelativePath(extractPathFromInput(input).raw);
	if (!read || !state.unread.includes(read)) {
		return state;
	}
	return { ...state, unread: state.unread.filter(path => path !== read) };
}

/**
 * `Created` / `Updated` are the success lines from the file tools.
 * Anything else (already exists, not found, cancelled, patch rejected) is not a write.
 */
function pathFromEditSuccess(resultText: string): string | undefined {
	const match = /^(?:Created|Updated) (\S(?:.*\S)?)$/.exec(resultText);
	if (!match) {
		return undefined;
	}
	return canonicalRelativePath(match[1]);
}

/**
 * File contents are returned as-is, including an empty file (`(empty tool result)`).
 * Known tool failures stay unread so a bad read does not count as a review.
 */
function readSucceeded(resultText: string): boolean {
	if (!resultText || resultText === '(empty tool result)') {
		return true;
	}
	return !/^(?:Tool error:|File not found:|Access denied|No workspace|Missing required |Path "|Absolute path|Invalid path|No workspace file named|Multiple workspace files named|Failed to )/.test(resultText);
}

function canonicalRelativePath(raw: string | undefined): string | undefined {
	if (!raw?.trim()) {
		return undefined;
	}
	const normalized = normalizeWorkspaceRelativePath(raw);
	return normalized || undefined;
}
