/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { estimateTokenCount } from '../providers/types';

export interface ContextUsageEstimate {
	readonly promptTokens: number;
	readonly completionTokens: number;
}

/**
 * Rough prompt/completion counts for the context meter.
 * The chat participant does not receive provider usage, so the ring uses the
 * same character estimate as the language-model token counter.
 */
export function estimateContextUsage(promptText: string, completionText: string): ContextUsageEstimate {
	return {
		promptTokens: promptText ? estimateTokenCount(promptText) : 0,
		completionTokens: completionText ? estimateTokenCount(completionText) : 0,
	};
}

/**
 * Flattens a language-model message's content into text that can be counted.
 * Accepts a string, text parts (`value`), and tool parts (`name` / `input`).
 */
export function textFromMessageContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const bits: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const record = part as { value?: unknown; name?: unknown; input?: unknown };
		if (typeof record.value === 'string') {
			bits.push(record.value);
		} else if (typeof record.name === 'string') {
			bits.push(record.input === undefined ? record.name : `${record.name} ${JSON.stringify(record.input)}`);
		}
	}
	return bits.join('\n');
}

export function promptTextFromMessages(messages: readonly { content: unknown }[]): string {
	return messages.map(message => textFromMessageContent(message.content)).filter(Boolean).join('\n');
}
