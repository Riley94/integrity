/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall } from './types';

/**
 * Result of attempting to parse a JSON tool call from free-form model text.
 */
export interface ParsedJsonToolCall {
	toolCall: ToolCall;
	/**
	 * Text that remained after extracting the tool-call JSON (may be empty).
	 */
	remainingText: string;
}

let fallbackIdCounter = 0;

function nextFallbackId(): string {
	fallbackIdCounter += 1;
	return `json_fallback_${fallbackIdCounter}`;
}

/**
 * Reset the fallback id counter (for tests).
 */
export function resetJsonFallbackIdCounter(): void {
	fallbackIdCounter = 0;
}

function asArgs(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return null;
		}
	}
	return null;
}

function toolCallFromObject(obj: Record<string, unknown>): ToolCall | null {
	const tool = obj.tool ?? obj.name ?? (obj.function as { name?: string } | undefined)?.name;
	if (typeof tool !== 'string' || !tool.trim()) {
		return null;
	}

	let args: Record<string, unknown> | null = null;
	if ('args' in obj) {
		args = asArgs(obj.args);
	} else if ('arguments' in obj) {
		args = asArgs(obj.arguments);
	} else if (obj.function && typeof obj.function === 'object') {
		args = asArgs((obj.function as { arguments?: unknown }).arguments);
	} else {
		// Treat the rest of the object (minus tool/name) as args.
		const { tool: _t, name: _n, id: _id, ...rest } = obj;
		args = rest;
	}

	if (!args) {
		return null;
	}

	const id = typeof obj.id === 'string' && obj.id ? obj.id : nextFallbackId();
	return { id, name: tool.trim(), arguments: args };
}

/**
 * Try to extract a single JSON object that looks like a tool call from model text.
 * Supports:
 * - bare JSON: {"tool":"read_file","args":{"path":"a.ts"}}
 * - fenced JSON blocks
 * - JSON embedded in prose
 * - OpenAI-ish shapes: {"name":"...","arguments":{...}}
 */
export function parseJsonToolCall(response: string): ParsedJsonToolCall | null {
	const trimmed = response.trim();
	if (!trimmed) {
		return null;
	}

	// Prefer fenced ```json ... ``` blocks.
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates: string[] = [];
	if (fenceMatch?.[1]) {
		candidates.push(fenceMatch[1].trim());
	}
	candidates.push(trimmed);

	// Also try the first {...} span in the response.
	const braceMatch = trimmed.match(/\{[\s\S]*\}/);
	if (braceMatch) {
		candidates.push(braceMatch[0]);
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const toolCall = toolCallFromObject(parsed as Record<string, unknown>);
				if (toolCall) {
					const remainingText = trimmed
						.replace(fenceMatch?.[0] ?? '', '')
						.replace(candidate, '')
						.trim();
					return { toolCall, remainingText };
				}
			}
		} catch {
			// try next candidate
		}
	}

	return null;
}

/**
 * When a model returns only text, attempt to recover a tool call via JSON fallback.
 * Returns the original text when no tool call is found.
 */
export function applyJsonToolCallFallback(
	text: string,
	hadNativeToolCalls: boolean,
): { text: string; toolCalls: ToolCall[] } {
	if (hadNativeToolCalls || !text.trim()) {
		return { text, toolCalls: [] };
	}
	const parsed = parseJsonToolCall(text);
	if (!parsed) {
		return { text, toolCalls: [] };
	}
	return {
		text: parsed.remainingText,
		toolCalls: [parsed.toolCall],
	};
}
