/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ChatOpts, CompleteOpts, Message, ModelInfo, ModelProvider, ProviderConfig, ProviderId } from './types';
import { streamLines } from './types';

export class OllamaProvider implements ModelProvider {
	readonly id = 'ollama';

	constructor(private readonly config: ProviderConfig['ollama']) { }

	private url(path: string): string {
		return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
	}

	async *chat(messages: Message[], opts?: ChatOpts): AsyncIterable<string> {
		const model = opts?.model ?? this.config.chatModel;
		const response = await fetch(this.url('/api/chat'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				messages: messages.map(m => ({ role: m.role, content: m.content })),
				stream: true,
				options: {
					temperature: opts?.temperature ?? 0.2,
					num_predict: opts?.maxTokens ?? 4096,
				},
			}),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
		}

		for await (const line of streamLines(response.body)) {
			try {
				const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
				if (parsed.message?.content) {
					yield parsed.message.content;
				}
			} catch {
				// skip malformed chunks
			}
		}
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
		const model = opts?.model ?? this.config.model;
		const response = await fetch(this.url('/chat/completions'), {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				model,
				messages: messages.map(m => ({ role: m.role, content: m.content })),
				stream: true,
				temperature: opts?.temperature ?? 0.2,
				max_tokens: opts?.maxTokens ?? 4096,
			}),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`OpenAI-compatible chat failed: ${response.status}`);
		}

		for await (const line of streamLines(response.body)) {
			if (!line.startsWith('data: ')) {
				continue;
			}
			const payload = line.slice(6).trim();
			if (payload === '[DONE]') {
				break;
			}
			try {
				const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
				const content = parsed.choices?.[0]?.delta?.content;
				if (content) {
					yield content;
				}
			} catch {
				// skip
			}
		}
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
		const model = opts?.model ?? this.config.model;
		const system = messages.find(m => m.role === 'system')?.content;
		const convo = messages.filter(m => m.role !== 'system').map(m => ({
			role: m.role === 'assistant' ? 'assistant' : 'user',
			content: m.content,
		}));

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				model,
				max_tokens: opts?.maxTokens ?? 4096,
				system,
				messages: convo,
				stream: true,
			}),
			signal: opts?.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`Anthropic chat failed: ${response.status}`);
		}

		for await (const line of streamLines(response.body)) {
			if (!line.startsWith('data: ')) {
				continue;
			}
			try {
				const parsed = JSON.parse(line.slice(6)) as {
					type?: string;
					delta?: { type?: string; text?: string };
				};
				if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
					yield parsed.delta.text;
				}
			} catch {
				// skip
			}
		}
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
