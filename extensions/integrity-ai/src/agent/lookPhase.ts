/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { extractPathFromInput, normalizeWorkspaceRelativePath } from './pathPolicy';
import { EDIT_TOOLS, IntegrityToolName, READ_ONLY_TOOLS } from './toolNames';

/**
 * Sentence added to the system prompt while edits are withheld.
 * The writer looks, then states a plan. It does not create or patch in this step.
 */
export const LOOK_PHASE_PROMPT =
	'Look at the workspace before editing. After a tool result, state which files you opened, what you will create or change, and the first edit.';

/**
 * Sentence added once a plan is recorded.
 * A patch or unique replace still needs a read of that file since its last write.
 */
export const LOOK_PLAN_PROMPT =
	'Follow the plan. Call integrity_read_file before integrity_apply_patch or integrity_replace_string when the file has not been read since its last write.';

/**
 * Continue message while the workspace has not been listed, searched, or read.
 * Names the look tools so the next step calls one instead of answering.
 */
export const LOOK_REQUIRED_MESSAGE =
	'List, search, or read the workspace before planning. Call integrity_list_dir, integrity_file_search, integrity_grep_search, integrity_codebase_search, or integrity_read_file. Do not answer yet.';

/**
 * Continue message after the plan is recorded.
 * The plan stays in the system prompt. This step edits instead of repeating it.
 */
export const LOOK_PLAN_CONTINUE_MESSAGE =
	'The plan is recorded. Follow it. Call integrity_read_file before integrity_apply_patch or integrity_replace_string when the file has not been read since its last write. Do not repeat the plan.';

/**
 * System prompt and continue message once a look tool has succeeded.
 * Further list, search, and read calls are not offered. A model that keeps calling them
 * never sends the text-only plan, and the turn runs until the step cap.
 */
export const LOOK_STATE_PLAN_MESSAGE =
	'The workspace has already been listed or read. State which files you opened, what you will create or change, and the first edit. Do not call tools.';

/**
 * Workspace tools whose success counts as having looked.
 * An empty listing or an empty search still counts. {@link IntegrityToolName.GetErrors} does not.
 */
const LOOK_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
	IntegrityToolName.ListDir,
	IntegrityToolName.FileSearch,
	IntegrityToolName.GrepSearch,
	IntegrityToolName.CodebaseSearch,
	IntegrityToolName.ReadFile,
]);

/**
 * Tool results that did not look at the workspace.
 * Anchored so file contents that mention these words still count as a read.
 */
const LOOK_FAILURE = /^(?:Tool error:|File not found:|Access denied|No workspace|Missing required |Path "|Absolute path|Invalid path|No workspace file named|Multiple workspace files named|Failed to |Directory not found:|pattern is required|glob is required|query is required)/;

export interface LookPhaseResult<T extends { name: string }> {
	/** True when this turn must look before editing. */
	active: boolean;
	/** Tools for the look. Same objects as `selected` when the phase is inactive. */
	tools: T[];
}

/**
 * Start a look phase when Jev kept an edit tool and the catalog can still list, search, or read.
 * Ask mode and a text-only or read-only Jev decision stay on `selected`.
 * While active, the turn offers every read-only Integrity tool in the catalog, plus the scratchpad
 * when `selected` already kept it. Edit tools and terminal tools stay on `selected` for later.
 */
export function beginLookPhase<T extends { name: string }>(
	selected: readonly T[],
	catalog: readonly T[],
): LookPhaseResult<T> {
	const hasEdit = selected.some(tool => EDIT_TOOLS.has(tool.name));
	const canLook = catalog.some(tool => LOOK_OBSERVATION_TOOLS.has(tool.name));
	if (!hasEdit || !canLook) {
		return { active: false, tools: [...selected] };
	}
	const scratchpadKept = selected.some(tool => tool.name === IntegrityToolName.Scratchpad);
	const seen = new Set<string>();
	const tools: T[] = [];
	for (const tool of catalog) {
		if (seen.has(tool.name)) {
			continue;
		}
		const readOnly = READ_ONLY_TOOLS.has(tool.name);
		const scratchpad = scratchpadKept && tool.name === IntegrityToolName.Scratchpad;
		if (!readOnly && !scratchpad) {
			continue;
		}
		seen.add(tool.name);
		tools.push(tool);
	}
	return { active: true, tools };
}

/** Whether the look phase is still withholding edits, and the plan recorded when it ended. */
export interface LookPhaseState {
	readonly active: boolean;
	/** True after a look tool has returned without a tool error. */
	readonly observed: boolean;
	/** Writer's plan. Empty until {@link finishLookPhase}. */
	readonly plan: string;
}

export function emptyLookPhaseState(active: boolean): LookPhaseState {
	return { active, observed: false, plan: '' };
}

/**
 * True when this look tool actually ran.
 * Empty listings and empty searches count. Failures and cancellations do not.
 */
export function observationSucceeded(toolName: string, resultText: string): boolean {
	if (!LOOK_OBSERVATION_TOOLS.has(toolName)) {
		return false;
	}
	const text = resultText.trim();
	if (!text || text === '(empty tool result)') {
		return toolName === IntegrityToolName.ReadFile;
	}
	return !LOOK_FAILURE.test(text);
}

/**
 * Record a settled tool call. A successful look marks the workspace observed.
 * Later calls leave that flag set. An inactive phase is unchanged.
 */
export function noteLookObservation(
	state: LookPhaseState,
	toolName: string,
	resultText: string,
): LookPhaseState {
	if (!state.active || state.observed || !observationSucceeded(toolName, resultText)) {
		return state;
	}
	return { ...state, observed: true };
}

/** What to do with a text-only assistant reply while edits are withheld. */
export type LookTextDecision =
	| { action: 'inactive' }
	| { action: 'hold'; message: string }
	| { action: 'plan'; message: string };

/**
 * Tools for the step after a look has succeeded.
 * An empty list makes the writer state the plan. The scratchpad stays only while it is still required,
 * so a runtime question can still run, and list, search, and read cannot be called again.
 */
export function toolsAfterObservation<T extends { name: string }>(
	lookTools: readonly T[],
	scratchpadPending: boolean,
): T[] {
	if (!scratchpadPending) {
		return [];
	}
	return lookTools.filter(tool => tool.name === IntegrityToolName.Scratchpad);
}

/**
 * Prose that can be stored as the plan. Blank text is not a plan.
 * Tool-call JSON stripped by the caller must not be passed in here.
 */
export function planFromObservedReply(text: string): string | undefined {
	const plan = text.trim();
	return plan ? plan : undefined;
}

/**
 * A text reply before any look continues the phase.
 * The first text-only reply after a look is the plan and does not finish the turn.
 * An inactive phase leaves the reply to the scratchpad and edit-review rules.
 */
export function holdReplyForLookPhase(state: LookPhaseState): LookTextDecision {
	if (!state.active) {
		return { action: 'inactive' };
	}
	if (!state.observed) {
		return { action: 'hold', message: LOOK_REQUIRED_MESSAGE };
	}
	return { action: 'plan', message: LOOK_PLAN_CONTINUE_MESSAGE };
}

/**
 * End the look phase and keep the plan for the system prompt.
 * `plan` is the text-only reply that {@link holdReplyForLookPhase} accepted.
 */
export function finishLookPhase(state: LookPhaseState, plan: string): LookPhaseState {
	return { active: false, observed: state.observed, plan: plan.trim() };
}

/** Paths read this turn since their last successful write. */
export interface ReadSinceWriteState {
	readonly paths: readonly string[];
}

export function emptyReadSinceWriteState(): ReadSinceWriteState {
	return { paths: [] };
}

/**
 * A successful read adds the path. A successful create, replace, or patch removes it,
 * so the next patch has to read the file again. Failures leave the set alone.
 */
export function noteReadSinceWrite(
	state: ReadSinceWriteState,
	toolName: string,
	input: unknown,
	resultText: string,
): ReadSinceWriteState {
	const text = resultText.trim();
	if (toolName === IntegrityToolName.ReadFile && readSucceeded(text)) {
		const read = canonicalRelativePath(extractPathFromInput(input).raw);
		if (!read || state.paths.includes(read)) {
			return state;
		}
		return { paths: [...state.paths, read] };
	}
	if (EDIT_TOOLS.has(toolName)) {
		const written = pathFromEditSuccess(text);
		if (!written || !state.paths.includes(written)) {
			return state;
		}
		return { paths: state.paths.filter(path => path !== written) };
	}
	return state;
}

/**
 * Reject a patch or unique replace when `paths` does not include the file.
 * Create stays allowed. Other tools are unchanged.
 */
export function rejectionForUnreadEdit(
	toolName: string,
	input: unknown,
	paths: readonly string[],
): string | undefined {
	if (toolName !== IntegrityToolName.ApplyPatch && toolName !== IntegrityToolName.ReplaceString) {
		return undefined;
	}
	const path = canonicalRelativePath(extractPathFromInput(input).raw);
	if (path && paths.includes(path)) {
		return undefined;
	}
	const target = path ?? 'the file';
	return `Read ${target} with integrity_read_file before editing it. It has not been read since its last write.`;
}

/**
 * File contents are returned as-is, including an empty file (`(empty tool result)`).
 * Known tool failures do not count as a read.
 */
function readSucceeded(resultText: string): boolean {
	if (!resultText || resultText === '(empty tool result)') {
		return true;
	}
	return !LOOK_FAILURE.test(resultText);
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

function canonicalRelativePath(raw: string | undefined): string | undefined {
	if (!raw?.trim()) {
		return undefined;
	}
	const normalized = normalizeWorkspaceRelativePath(raw);
	return normalized || undefined;
}
