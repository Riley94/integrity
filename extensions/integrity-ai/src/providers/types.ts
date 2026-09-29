/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat message roles used by Integrity providers.
 */
export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	toolCallId?: string;
	/**
	 * Tool calls emitted by an assistant turn (OpenAI-style).
	 * Used when replaying history into subsequent provider requests.
	 */
	toolCalls?: ToolCall[];
}

export interface ModelInfo {
	id: string;
	name: string;
}

/**
 * JSON Schema describing a tool the model may call.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters?: object;
}

/**
 * A single tool invocation requested by the model.
 */
export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Streaming chat response parts: either text or a completed tool call.
 */
export type ChatPart =
	| { type: 'text'; text: string }
	| { type: 'tool_call'; toolCall: ToolCall };

export interface ChatOpts {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	/**
	 * Tools available for this request. When set, providers should
	 * request native function calling when the backend supports it.
	 */
	tools?: readonly ToolDefinition[];
	/**
	 * When true, force the model to call a tool (provider-dependent).
	 */
	toolChoice?: 'auto' | 'required' | 'none';
}

export interface CompleteOpts extends ChatOpts {
	stop?: string[];
}

/**
 * Model provider contract. Prefer {@link ModelProvider.chatParts} for
 * agent loops; {@link ModelProvider.chat} remains a text-only convenience.
 */
export interface ModelProvider {
	readonly id: string;
	/**
	 * Text-only streaming chat. Ignores tool call parts.
	 */
	chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string>;
	/**
	 * Streaming chat that yields text and tool-call parts.
	 */
	chatParts(messages: Message[], opts?: ChatOpts): AsyncIterable<ChatPart>;
	complete(prompt: string, opts?: CompleteOpts): AsyncIterable<string>;
	embed(texts: string[], opts?: ChatOpts): Promise<number[][]>;
	listModels(): Promise<ModelInfo[]>;
	testConnection(): Promise<boolean>;
}

export type ProviderId = 'ollama' | 'openai-compat' | 'anthropic';

export interface ProviderConfig {
	defaultProvider: ProviderId;
	cloudFallbackEnabled: boolean;
	ollama: {
		baseUrl: string;
		chatModel: string;
		completionModel: string;
		embeddingModel: string;
	};
	openaiCompat: {
		baseUrl: string;
		apiKey: string;
		model: string;
	};
	anthropic: {
		apiKey: string;
		model: string;
	};
}

export async function* streamLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim()) {
				yield line;
			}
		}
	}

	if (buffer.trim()) {
		yield buffer;
	}
}

/**
 * Rough token estimate (~4 chars/token). Good enough for v1 budgeting.
 */
export function estimateTokenCount(text: string): number {
	if (!text) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / 4));
}

export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Collect all parts from a chatParts stream into text + toolCalls.
 */
export async function collectChatParts(
	parts: AsyncIterable<ChatPart>,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
	let text = '';
	const toolCalls: ToolCall[] = [];
	for await (const part of parts) {
		if (part.type === 'text') {
			text += part.text;
		} else {
			toolCalls.push(part.toolCall);
		}
	}
	return { text, toolCalls };
}
