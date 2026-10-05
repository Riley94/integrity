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

function readJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
	try {
		return { parsed: true, value: JSON.parse(text) as unknown };
	} catch {
		return { parsed: false };
	}
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

/**
 * Replace Python triple-quoted strings with JSON strings.
 * Models wrap a patch body in `"""` ... `"""`, which JSON.parse rejects.
 * The inner source, including quotes, is escaped by JSON.stringify.
 */
function replaceTripleQuotedStrings(input: string): string {
	return input.replace(/"""([\s\S]*?)"""|'''([\s\S]*?)'''/g, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
		return JSON.stringify(doubleQuoted ?? singleQuoted ?? '');
	});
}

/**
 * A quote ends a JSON string when the next non-space character is structural.
 * An interior quote such as text="=" is escaped. A quote followed by a comma,
 * as in text="1", padx, is left alone: closing there would apply a truncated patch.
 */
function isJsonStringCloser(input: string, index: number): boolean {
	let i = index;
	while (i < input.length && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r')) {
		i++;
	}
	if (i >= input.length) {
		return true;
	}
	const next = input[i];
	return next === ',' || next === '}' || next === ']' || next === ':';
}

/**
 * Escape raw quotes and newlines inside JSON strings.
 * Valid JSON never reaches here. The result is parsed only when it is still one object.
 */
function repairLooseJsonStrings(input: string): string {
	let out = '';
	let i = 0;
	while (i < input.length) {
		if (input[i] !== '"') {
			out += input[i];
			i++;
			continue;
		}
		out += '"';
		i++;
		while (i < input.length) {
			const ch = input[i];
			if (ch === '\\') {
				out += ch;
				i++;
				if (i < input.length) {
					out += input[i];
					i++;
				}
				continue;
			}
			if (ch === '"') {
				if (isJsonStringCloser(input, i + 1)) {
					out += '"';
					i++;
					break;
				}
				out += '\\"';
				i++;
				continue;
			}
			if (ch === '\n') {
				out += '\\n';
				i++;
				continue;
			}
			if (ch === '\r') {
				out += '\\r';
				i++;
				continue;
			}
			out += ch;
			i++;
		}
	}
	return out;
}

/**
 * Repair a printed tool call enough for JSON.parse.
 * Triple quotes are rewritten first so a patch body can contain quotes and newlines.
 * Quote repair runs only when that text is still not JSON.
 */
function normalizePrintedJson(input: string): string {
	const withTriples = replaceTripleQuotedStrings(input);
	if (readJson(withTriples).parsed) {
		return withTriples;
	}
	return repairLooseJsonStrings(withTriples);
}

/**
 * Parse one object from printed JSON. A value that already parses is not repaired.
 */
function objectFromPrintedJson(candidate: string): Record<string, unknown> | null {
	const direct = readJson(candidate);
	if (direct.parsed) {
		return asObject(direct.value);
	}
	const repaired = readJson(normalizePrintedJson(candidate));
	if (!repaired.parsed) {
		return null;
	}
	return asObject(repaired.value);
}

/**
 * Try to extract a single JSON object that looks like a tool call from model text.
 * Supports:
 * - bare JSON: {"tool":"read_file","args":{"path":"a.ts"}}
 * - fenced JSON blocks
 * - JSON embedded in prose
 * - OpenAI-ish shapes: {"name":"...","arguments":{...}}
 * - Python triple-quoted strings and raw quotes inside a string value
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
		const parsed = objectFromPrintedJson(candidate);
		if (!parsed) {
			continue;
		}
		const toolCall = toolCallFromObject(parsed);
		if (toolCall) {
			const remainingText = trimmed
				.replace(fenceMatch?.[0] ?? '', '')
				.replace(candidate, '')
				.trim();
			return { toolCall, remainingText };
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

/**
 * A tool call the model wrote as text instead of invoking.
 * `parsed` is JSON, including a printed patch whose quotes were repaired.
 * `unparsed` names a tool inside JSON that still did not parse.
 */
export type PrintedToolCall =
	| { kind: 'parsed'; toolCall: ToolCall }
	| { kind: 'unparsed'; name: string };

const PRINTED_TOOL_NAME = /"(?:name|tool)"\s*:\s*"([^"\\]+)"/;

/**
 * Detect a tool call printed in the reply.
 * A normal sentence that merely mentions a tool name is ignored.
 */
export function classifyPrintedToolCall(text: string): PrintedToolCall | undefined {
	const parsed = parseJsonToolCall(text);
	if (parsed) {
		return { kind: 'parsed', toolCall: parsed.toolCall };
	}
	const name = text.match(PRINTED_TOOL_NAME)?.[1]?.trim();
	if (!name) {
		return undefined;
	}
	return { kind: 'unparsed', name };
}

/**
 * What to do with a tool the model printed as JSON that still did not parse.
 * One correction asks for a single valid object. The same tool printed unparsed
 * again ends the turn: another nudge does not make a JSON-only model emit a native call.
 */
export type UnparsedPrintedToolDecision = {
	action: 'correct' | 'stop';
	corrected: ReadonlySet<string>;
};

/**
 * Record the first unparsed print of `name`, or stop when it was already corrected.
 */
export function decideUnparsedPrintedTool(
	alreadyCorrected: ReadonlySet<string>,
	name: string,
): UnparsedPrintedToolDecision {
	if (alreadyCorrected.has(name)) {
		return { action: 'stop', corrected: alreadyCorrected };
	}
	const corrected = new Set(alreadyCorrected);
	corrected.add(name);
	return { action: 'correct', corrected };
}

/**
 * Correction sent once when a printed tool call could not be parsed.
 * Asks for one JSON object with escaped quotes. A model that only prints JSON
 * cannot satisfy a request to emit a native tool call.
 */
export function printedToolCallMessage(name: string): string {
	return `The call to ${name} was printed as JSON that did not parse, so it did not run. Print one JSON object for ${name}. Escape every double quote inside string values as \\". Do not wrap values in triple quotes.`;
}

/**
 * Shown when a printed tool call still does not parse after that one correction.
 */
export function unparsedPrintedToolStopMessage(name: string): string {
	return `**Could not run \`${name}\`.** The printed call is not valid JSON, so it was not applied.`;
}
