/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IntegrityToolName } from './toolNames';

/**
 * Continue message while a runtime question has not been executed.
 * Names the scratchpad so the next step calls it instead of writing another summary.
 */
export const SCRATCHPAD_REQUIRED_MESSAGE =
	'Run the user\'s Python snippets with integrity_scratchpad before answering. Use the tool stdout and stderr. Do not repeat the previous summary.';

/** Sentence added to the system prompt when the host rule keeps the scratchpad. */
export const SCRATCHPAD_REQUIRED_PROMPT =
	'The question depends on running the Python in the prompt. Call integrity_scratchpad with those snippets before answering. Base the answer on the tool stdout and stderr.';

/**
 * Any fenced block. Group 1 is the info string (`python`, empty, `js`, …) and group 2 is the body.
 * The closer must be on its own line. Chat often drops the language tag, so an empty tag is allowed
 * and the body is checked separately.
 */
const FENCE = /^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```/gim;

/** Words that refer to what the snippet does when executed. */
const RUNTIME_WORD = /\b(output|outputs|result|results|return|returns|returned|print|prints|printed|stdout|stderr|traceback|behavior|behaves|behaviour|expected)\b/i;

/** A claim that the observed behavior is wrong. */
const DEFECT = /\b(bug|incorrect|unexpected|wrong|broken|fail|fails|failed|failure)\b|does not|doesn't|doesn’t|no longer/i;

/** A REPL line inside a pasted session. The output under it is what the question is about. */
const REPL_PROMPT = /^[ \t]*>>>[ \t]+\S/m;

/** A statement that identifies an untagged fence as Python rather than a shell or data block. */
const PYTHON_STATEMENT = /^[ \t]*(?:from[ \t]+\S|import[ \t]+\S|def[ \t]+\S|class[ \t]+\S|async[ \t]+def[ \t]+\S)/m;

/**
 * Whether this prompt asks about the runtime output of pasted Python.
 * A fence alone does not match: a snippet shown for an edit stays on Jev's tool choice.
 * Tagged `python`/`py` fences count, and so do untagged fences whose body is Python.
 * The scratchpad is required when the prose outside the fences asks about that output,
 * claims the behavior is wrong, or the fence is a `>>>` session.
 */
export function promptRequiresScratchpad(prompt: string): boolean {
	const normalized = prompt.replace(/\r\n/g, '\n');
	FENCE.lastIndex = 0;
	const bodies: string[] = [];
	const prose = normalized.replace(FENCE, (_match, info: string, body: string) => {
		if (isPythonBody(info, body)) {
			bodies.push(body);
		}
		return '\n';
	});
	if (!bodies.length) {
		return false;
	}
	if (bodies.some(body => REPL_PROMPT.test(body))) {
		return true;
	}
	if (DEFECT.test(prose)) {
		return true;
	}
	return prose.includes('?') && RUNTIME_WORD.test(prose);
}

/**
 * True for a `python` or `py` tag, including `python3`.
 * An untagged fence counts only when the body itself is Python, because the chat input
 * often stores a pasted ```python block with the language tag removed.
 */
function isPythonBody(info: string, body: string): boolean {
	if (!body.trim()) {
		return false;
	}
	const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	if (/^py(?:thon)?\d*$/.test(lang)) {
		return true;
	}
	if (lang) {
		return false;
	}
	return REPL_PROMPT.test(body) || PYTHON_STATEMENT.test(body) || /\bprint[ \t]*\(/.test(body);
}

export interface ScratchpadHostRuleResult<T extends { name: string }> {
	/** Tools for this turn. The scratchpad is appended when the host rule keeps it. */
	tools: T[];
	/**
	 * True when the prompt asks about Python output and the scratchpad was still offered.
	 * A text reply cannot finish the turn until that tool has been called.
	 */
	forced: boolean;
}

/**
 * Keep {@link IntegrityToolName.Scratchpad} available when {@link promptRequiresScratchpad} is true.
 * Jev's other selections stay. A text-only Jev decision becomes a scratchpad turn.
 * A catalog that omitted the scratchpad (edit mode, or the user disabled it) is unchanged,
 * because the host cannot call a tool this turn does not offer.
 */
export function applyScratchpadHostRule<T extends { name: string }>(
	selected: readonly T[],
	catalog: readonly T[],
	prompt: string,
): ScratchpadHostRuleResult<T> {
	if (!promptRequiresScratchpad(prompt)) {
		return { tools: [...selected], forced: false };
	}
	const scratchpad = catalog.find(tool => tool.name === IntegrityToolName.Scratchpad);
	if (!scratchpad) {
		return { tools: [...selected], forced: false };
	}
	if (selected.some(tool => tool.name === IntegrityToolName.Scratchpad)) {
		return { tools: [...selected], forced: true };
	}
	return { tools: [...selected, scratchpad], forced: true };
}

/** What to do with a text-only assistant reply. */
export type TextReplyDecision =
	| { action: 'exit' }
	| { action: 'continue'; message: string };

/**
 * A text reply ends the turn unless the scratchpad is still required.
 * The host does not ask Jev whether the task is complete. While `pending` is true,
 * the next step is told to run the snippet via {@link SCRATCHPAD_REQUIRED_MESSAGE}.
 * The step cap still ends the loop.
 */
export function holdReplyForScratchpad(pending: boolean): TextReplyDecision {
	if (!pending) {
		return { action: 'exit' };
	}
	return {
		action: 'continue',
		message: SCRATCHPAD_REQUIRED_MESSAGE,
	};
}
