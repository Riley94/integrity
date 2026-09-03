/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ChatPart, ToolCall, ToolDefinition } from './types';

/**
 * Convert Integrity tool definitions to OpenAI function-calling format.
 */
export function toolsToOpenAIFormat(tools: readonly ToolDefinition[]): object[] {
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters ?? { type: 'object', properties: {} },
		},
	}));
}

/**
 * Convert Integrity tool definitions to Anthropic tool format.
 */
export function toolsToAnthropicFormat(tools: readonly ToolDefinition[]): object[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters ?? { type: 'object', properties: {} },
	}));
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return {};
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return { raw };
		}
	}
	return {};
}

let toolCallSeq = 0;

function ensureToolCallId(id: string | undefined): string {
	if (id && id.length > 0) {
		return id;
	}
	toolCallSeq += 1;
	return `call_${toolCallSeq}`;
}

/**
 * Reset synthetic tool-call id counter (for tests).
 */
export function resetToolCallIdCounter(): void {
	toolCallSeq = 0;
}

/**
 * Parse one NDJSON line from Ollama `/api/chat` into zero or more chat parts.
 */
export function parseOllamaChatLine(line: string): ChatPart[] {
	const parts: ChatPart[] = [];
	let parsed: {
		message?: {
			content?: string;
			tool_calls?: Array<{
				id?: string;
				function?: { name?: string; arguments?: unknown };
			}>;
		};
	};
	try {
		parsed = JSON.parse(line) as typeof parsed;
	} catch {
		return parts;
	}

	const content = parsed.message?.content;
	if (content) {
		parts.push({ type: 'text', text: content });
	}

	const toolCalls = parsed.message?.tool_calls;
	if (Array.isArray(toolCalls)) {
		for (const tc of toolCalls) {
			const name = tc.function?.name;
			if (!name) {
				continue;
			}
			parts.push({
				type: 'tool_call',
				toolCall: {
					id: ensureToolCallId(tc.id),
					name,
					arguments: parseToolArguments(tc.function?.arguments),
				},
			});
		}
	}

	return parts;
}

/**
 * Accumulator for OpenAI-compatible SSE tool_call deltas (index-based streaming).
 */
export class OpenAIToolCallAccumulator {
	private readonly pending = new Map<number, { id: string; name: string; arguments: string }>();

	/**
	 * Ingest one SSE `data:` payload (without the `data: ` prefix).
	 * Returns text parts immediately; completed tool calls are returned from {@link finish}.
	 */
	ingest(payload: string): ChatPart[] {
		const parts: ChatPart[] = [];
		if (payload === '[DONE]') {
			return parts;
		}

		let parsed: {
			choices?: Array<{
				delta?: {
					content?: string | null;
					tool_calls?: Array<{
						index?: number;
						id?: string;
						function?: { name?: string; arguments?: string };
					}>;
				};
			}>;
		};
		try {
			parsed = JSON.parse(payload) as typeof parsed;
		} catch {
			return parts;
		}

		const delta = parsed.choices?.[0]?.delta;
		if (!delta) {
			return parts;
		}

		if (typeof delta.content === 'string' && delta.content.length > 0) {
			parts.push({ type: 'text', text: delta.content });
		}

		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const index = tc.index ?? 0;
				const existing = this.pending.get(index) ?? { id: '', name: '', arguments: '' };
				if (tc.id) {
					existing.id = tc.id;
				}
				if (tc.function?.name) {
					existing.name += tc.function.name;
				}
				if (tc.function?.arguments) {
					existing.arguments += tc.function.arguments;
				}
				this.pending.set(index, existing);
			}
		}

		return parts;
	}

	/**
	 * Flush accumulated tool calls after the stream ends.
	 */
	finish(): ChatPart[] {
		const parts: ChatPart[] = [];
		const indices = [...this.pending.keys()].sort((a, b) => a - b);
		for (const index of indices) {
			const pending = this.pending.get(index)!;
			if (!pending.name) {
				continue;
			}
			parts.push({
				type: 'tool_call',
				toolCall: {
					id: ensureToolCallId(pending.id),
					name: pending.name,
					arguments: parseToolArguments(pending.arguments),
				},
			});
		}
		this.pending.clear();
		return parts;
	}
}

/**
 * Accumulator for Anthropic SSE tool_use content blocks.
 */
export class AnthropicToolCallAccumulator {
	private readonly blocks = new Map<number, { id: string; name: string; inputJson: string }>();

	/**
	 * Ingest one SSE `data:` payload (without the `data: ` prefix).
	 */
	ingest(payload: string): ChatPart[] {
		const parts: ChatPart[] = [];
		let parsed: {
			type?: string;
			index?: number;
			content_block?: { type?: string; id?: string; name?: string };
			delta?: { type?: string; text?: string; partial_json?: string };
		};
		try {
			parsed = JSON.parse(payload) as typeof parsed;
		} catch {
			return parts;
		}

		if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
			const index = parsed.index ?? 0;
			this.blocks.set(index, {
				id: parsed.content_block.id ?? ensureToolCallId(undefined),
				name: parsed.content_block.name ?? '',
				inputJson: '',
			});
			return parts;
		}

		if (parsed.type === 'content_block_delta') {
			if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
				parts.push({ type: 'text', text: parsed.delta.text });
			}
			if (parsed.delta?.type === 'input_json_delta' && typeof parsed.delta.partial_json === 'string') {
				const index = parsed.index ?? 0;
				const block = this.blocks.get(index);
				if (block) {
					block.inputJson += parsed.delta.partial_json;
				}
			}
			return parts;
		}

		if (parsed.type === 'content_block_stop') {
			const index = parsed.index ?? 0;
			const block = this.blocks.get(index);
			if (block?.name) {
				parts.push({
					type: 'tool_call',
					toolCall: {
						id: ensureToolCallId(block.id),
						name: block.name,
						arguments: parseToolArguments(block.inputJson),
					} satisfies ToolCall,
				});
				this.blocks.delete(index);
			}
		}

		return parts;
	}
}
