/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stable id so streamed deltas accumulate in one Thinking box.
 * Look-phase prose, prose that shares a step with tool calls, and prose held for the
 * scratchpad or an edit review all use this id. A text-only reply outside the look phase
 * is the visible answer and does not.
 */
export const THINKING_PART_ID = 'integrity-thinking';
