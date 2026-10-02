/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * System line for the text-only thinking call.
 * The writer does not see this prompt. It only sees {@link thinkingContextMessage}.
 */
export const THINKING_SYSTEM_PROMPT =
	'You are preparing notes for yourself. Answer the questions. Do not solve the task.';

/** Stable id so streamed deltas accumulate in one Thinking box. */
export const THINKING_PART_ID = 'integrity-thinking';

/**
 * User message for the thinking call.
 * Asks four questions about `prompt` and withholds a solution, code, and tool calls.
 */
export function buildThinkingRequest(prompt: string): string {
	return [
		'Answer these questions about the request, in a few sentences. Do not solve the task. Do not write code. Do not call tools.',
		'',
		'What is the user asking for?',
		'What would make the result wrong or incomplete?',
		'What must be checked or decided before answering or editing?',
		'What is the first concrete step?',
		'',
		'Request:',
		prompt,
	].join('\n');
}

/**
 * Private note appended after the user prompt so the writer follows the thinking trace
 * without repeating it in the visible reply.
 * An empty or whitespace trace returns undefined.
 */
export function thinkingContextMessage(trace: string): string | undefined {
	if (!trace.trim()) {
		return undefined;
	}
	return [
		'Private notes from thinking. Follow them. Do not repeat them in the visible reply.',
		'',
		trace.trim(),
	].join('\n');
}
