/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	toolCallId?: string;
}

export interface ModelInfo {
	id: string;
	name: string;
}

export interface ChatOpts {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface CompleteOpts extends ChatOpts {
	stop?: string[];
}

export interface ModelProvider {
	readonly id: string;
	chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string>;
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
