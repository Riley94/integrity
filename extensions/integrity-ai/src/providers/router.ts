/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ChatOpts, ChatPart, CompleteOpts, Message, ModelInfo, ModelProvider, ProviderConfig, ProviderId, ToolCall } from './types';
import { streamLines } from './types';
import {
	AnthropicToolCallAccumulator,
	OpenAIToolCallAccumulator,
	parseOllamaChatLine,
	toolsToAnthropicFormat,
	toolsToOpenAIFormat,
} from './streamParsers';
import { applyJsonToolCallFallback } from './jsonToolFallback';

async function* textFromParts(parts: AsyncIterable<ChatPart>): AsyncIterable<string> {
	for await (const part of parts) {
		if (part.type === 'text') {
			yield part.text;
		}
	}
}

function messagesForOpenAI(messages: Message[]): object[] {
	return messages.map(m => {
		if (m.role === 'tool') {
			return {
				role: 'tool',
				tool_call_id: m.toolCallId,
				content: m.content,
			};
		}
		if (m.role === 'assistant' && m.toolCalls?.length) {
			return {
				role: 'assistant',
				content: m.content || null,
				tool_calls: m.toolCalls.map(tc => ({
					id: tc.id,
					type: 'function',
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				})),
			};
		}
		return { role: m.role, content: m.content };
	});
}

function messagesForOllama(messages: Message[]): object[] {
	return messages.map(m => {
		if (m.role === 'tool') {
			return {
				role: 'tool',
				content: m.content,
				tool_name: m.name,
			};
		}
		if (m.role === 'assistant' && m.toolCalls?.length) {
			return {
				role: 'assistant',
				content: m.content,
				tool_calls: m.toolCalls.map(tc => ({
					id: tc.id,
					function: {
						name: tc.name,
						arguments: tc.arguments,
					},
				})),
			};
		}
		return { role: m.role, content: m.content };
	});
}

function messagesForAnthropic(messages: Message[]): { system?: string; messages: object[] } {
	const system = messages.find(m => m.role === 'system')?.content;
	const convo: object[] = [];

	for (const m of messages) {
		if (m.role === 'system') {
			continue;
		}
		if (m.role === 'tool') {
			convo.push({
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: m.toolCallId,
					content: m.content,
				}],
			});
			continue;
		}
		if (m.role === 'assistant' && m.toolCalls?.length) {
			const content: object[] = [];
			if (m.content) {
				content.push({ type: 'text', text: m.content });
			}
			for (const tc of m.toolCalls) {
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.name,
					input: tc.arguments,
				});
			}
			convo.push({ role: 'assistant', content });
			continue;
		}
		convo.push({
			role: m.role === 'assistant' ? 'assistant' : 'user',
			content: m.content,
		});
	}

	return { system, messages: convo };
}

/**
 * Yield chat parts, then apply JSON tool-call fallback when the model
 * returned only text despite tools being offered.
 */
async function* withJsonFallback(
	parts: AsyncIterable<ChatPart>,
	toolsEnabled: boolean,
): AsyncIterable<ChatPart> {
	if (!toolsEnabled) {
		yield* parts;
		return;
	}

	let text = '';
	let hadNativeToolCalls = false;
	for await (const part of parts) {
		if (part.type === 'text') {
			text += part.text;
			yield part;
		} else {
			hadNativeToolCalls = true;
			yield part;
		}
	}

	if (!hadNativeToolCalls && text.trim()) {
		const recovered = applyJsonToolCallFallback(text, false);
		for (const tc of recovered.toolCalls) {
			yield { type: 'tool_call', toolCall: tc };
		}
	}
}

export class OllamaProvider implements ModelProvider {
	readonly id = 'ollama';

	constructor(private readonly config: ProviderConfig['ollama']) { }

	private url(path: string): string {
		return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
	}

	async *chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string> {
		yield* textFromParts(this.chatParts(messages, opts));
	}

	async *chatParts(messages: Message[], opts?: ChatOpts): AsyncIterable<ChatPart> {
		const model = opts?.model ?? this.config.chatModel;
		const tools = opts?.tools?.length ? toolsToOpenAIFormat(opts.tools) : undefined;
		const body: Record<string, unknown> = {
			model,
			messages: messagesForOllama(messages),
			stream: true,
			options: {
				temperature: opts?.temperature ?? 0.2,
				num_predict: opts?.maxTokens ?? 4096,
			},
		};
		if (tools) {
			body.tools = tools;
		}

		const response = await fetch(this.url('/api/chat'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
		}

		async function* parseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatPart> {
			for await (const line of streamLines(stream)) {
				for (const part of parseOllamaChatLine(line)) {
					yield part;
				}
			}
		}

		yield* withJsonFallback(parseStream(response.body), !!tools);
	}

	async *complete(prompt: string, opts?: CompleteOpts): AsyncIterable<string> {
		yield* this.chat([{ role: 'user', content: prompt }], {
			...opts,
			model: opts?.model ?? this.config.completionModel,
		});
	}

	async embed(texts: string[], opts?: ChatOpts): Promise<number[][]> {
		const model = opts?.model ?? this.config.embeddingModel;
		const results: number[][] = [];

		for (const text of texts) {
			const response = await fetch(this.url('/api/embeddings'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, prompt: text }),
				signal: opts?.signal,
			});

			if (!response.ok) {
				throw new Error(`Ollama embed failed: ${response.status}`);
			}

			const data = await response.json() as { embedding: number[] };
			results.push(data.embedding);
		}

		return results;
	}

	async listModels(): Promise<ModelInfo[]> {
		const response = await fetch(this.url('/api/tags'));
		if (!response.ok) {
			return [];
		}
		const data = await response.json() as { models?: Array<{ name: string }> };
		return (data.models ?? []).map(m => ({ id: m.name, name: m.name }));
	}

	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(this.url('/api/tags'));
			return response.ok;
		} catch {
			return false;
		}
	}
}

export class OpenAICompatProvider implements ModelProvider {
	readonly id = 'openai-compat';

	constructor(private readonly config: ProviderConfig['openaiCompat']) { }

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}
		return headers;
	}

	private url(path: string): string {
		return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
	}

	async *chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string> {
		yield* textFromParts(this.chatParts(messages, opts));
	}

	async *chatParts(messages: Message[], opts?: ChatOpts): AsyncIterable<ChatPart> {
		const model = opts?.model ?? this.config.model;
		const tools = opts?.tools?.length ? toolsToOpenAIFormat(opts.tools) : undefined;
		const body: Record<string, unknown> = {
			model,
			messages: messagesForOpenAI(messages),
			stream: true,
			temperature: opts?.temperature ?? 0.2,
			max_tokens: opts?.maxTokens ?? 4096,
		};
		if (tools) {
			body.tools = tools;
			if (opts?.toolChoice && opts.toolChoice !== 'auto') {
				body.tool_choice = opts.toolChoice;
			}
		}

		const response = await fetch(this.url('/chat/completions'), {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`OpenAI-compatible chat failed: ${response.status}`);
		}

		async function* parseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatPart> {
			const accumulator = new OpenAIToolCallAccumulator();
			for await (const line of streamLines(stream)) {
				if (!line.startsWith('data: ')) {
					continue;
				}
				const payload = line.slice(6).trim();
				for (const part of accumulator.ingest(payload)) {
					yield part;
				}
				if (payload === '[DONE]') {
					break;
				}
			}
			for (const part of accumulator.finish()) {
				yield part;
			}
		}

		yield* withJsonFallback(parseStream(response.body), !!tools);
	}

	async *complete(prompt: string, opts?: CompleteOpts): AsyncIterable<string> {
		yield* this.chat([{ role: 'user', content: prompt }], opts);
	}

	async embed(texts: string[], opts?: ChatOpts): Promise<number[][]> {
		const model = opts?.model ?? this.config.model;
		const response = await fetch(this.url('/embeddings'), {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ model, input: texts }),
			signal: opts?.signal,
		});

		if (!response.ok) {
			throw new Error(`OpenAI-compatible embed failed: ${response.status}`);
		}

		const data = await response.json() as { data: Array<{ embedding: number[] }> };
		return data.data.map(d => d.embedding);
	}

	async listModels(): Promise<ModelInfo[]> {
		return [{ id: this.config.model, name: this.config.model }];
	}

	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(this.url('/models'), { headers: this.headers() });
			return response.ok;
		} catch {
			return false;
		}
	}
}

export class AnthropicProvider implements ModelProvider {
	readonly id = 'anthropic';

	constructor(private readonly config: ProviderConfig['anthropic']) { }

	private headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'x-api-key': this.config.apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	async *chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string> {
		yield* textFromParts(this.chatParts(messages, opts));
	}

	async *chatParts(messages: Message[], opts?: ChatOpts): AsyncIterable<ChatPart> {
		const model = opts?.model ?? this.config.model;
		const { system, messages: convo } = messagesForAnthropic(messages);
		const tools = opts?.tools?.length ? toolsToAnthropicFormat(opts.tools) : undefined;
		const body: Record<string, unknown> = {
			model,
			max_tokens: opts?.maxTokens ?? 4096,
			system,
			messages: convo,
			stream: true,
		};
		if (tools) {
			body.tools = tools;
			if (opts?.toolChoice === 'required') {
				body.tool_choice = { type: 'any' };
			} else if (opts?.toolChoice === 'none') {
				body.tool_choice = { type: 'none' };
			}
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`Anthropic chat failed: ${response.status}`);
		}

		async function* parseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ChatPart> {
			const accumulator = new AnthropicToolCallAccumulator();
			for await (const line of streamLines(stream)) {
				if (!line.startsWith('data: ')) {
					continue;
				}
				for (const part of accumulator.ingest(line.slice(6))) {
					yield part;
				}
			}
		}

		yield* withJsonFallback(parseStream(response.body), !!tools);
	}

	async *complete(prompt: string, opts?: CompleteOpts): AsyncIterable<string> {
		yield* this.chat([{ role: 'user', content: prompt }], opts);
	}

	async embed(_texts: string[], _opts?: ChatOpts): Promise<number[][]> {
		throw new Error('Anthropic provider does not support embeddings. Use Ollama for codebase indexing.');
	}

	async listModels(): Promise<ModelInfo[]> {
		return [{ id: this.config.model, name: this.config.model }];
	}

	async testConnection(): Promise<boolean> {
		if (!this.config.apiKey) {
			return false;
		}
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({
					model: this.config.model,
					max_tokens: 1,
					messages: [{ role: 'user', content: 'ping' }],
				}),
			});
			return response.status !== 401;
		} catch {
			return false;
		}
	}
}

export function getProviderConfig(): ProviderConfig {
	const cfg = vscode.workspace.getConfiguration('integrity.ai');
	return {
		defaultProvider: cfg.get<ProviderId>('defaultProvider', 'ollama'),
		cloudFallbackEnabled: cfg.get<boolean>('cloudFallbackEnabled', false),
		ollama: {
			baseUrl: cfg.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
			chatModel: cfg.get<string>('ollama.chatModel', 'qwen2.5-coder:14b'),
			completionModel: cfg.get<string>('ollama.completionModel', 'qwen2.5-coder:7b'),
			embeddingModel: cfg.get<string>('ollama.embeddingModel', 'nomic-embed-text'),
		},
		openaiCompat: {
			baseUrl: cfg.get<string>('openaiCompat.baseUrl', 'https://api.openai.com/v1'),
			apiKey: cfg.get<string>('openaiCompat.apiKey', ''),
			model: cfg.get<string>('openaiCompat.model', 'gpt-4o-mini'),
		},
		anthropic: {
			apiKey: cfg.get<string>('anthropic.apiKey', ''),
			model: cfg.get<string>('anthropic.model', 'claude-sonnet-4-20250514'),
		},
	};
}

export class ProviderRouter {
	constructor(private readonly config: ProviderConfig) { }

	getConfig(): ProviderConfig {
		return this.config;
	}

	getProvider(id?: ProviderId): ModelProvider {
		const providerId = id ?? this.config.defaultProvider;
		switch (providerId) {
			case 'openai-compat':
				return new OpenAICompatProvider(this.config.openaiCompat);
			case 'anthropic':
				return new AnthropicProvider(this.config.anthropic);
			case 'ollama':
			default:
				return new OllamaProvider(this.config.ollama);
		}
	}

	async getAvailableProvider(preferred?: ProviderId): Promise<ModelProvider> {
		const order: ProviderId[] = preferred
			? [preferred, 'ollama', 'openai-compat', 'anthropic']
			: [this.config.defaultProvider, 'ollama', 'openai-compat', 'anthropic'];

		const tried = new Set<ProviderId>();
		for (const id of order) {
			if (tried.has(id)) {
				continue;
			}
			tried.add(id);
			if (!this.config.cloudFallbackEnabled && id !== 'ollama' && this.config.defaultProvider === 'ollama') {
				continue;
			}
			const provider = this.getProvider(id);
			if (await provider.testConnection()) {
				return provider;
			}
		}

		return this.getProvider(this.config.defaultProvider);
	}

	getEmbeddingProvider(): ModelProvider {
		return new OllamaProvider(this.config.ollama);
	}
}

export type { ToolCall };
