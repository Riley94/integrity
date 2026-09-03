/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderRouter } from './router';
import type { Message, ToolCall, ToolDefinition } from './types';
import { estimateTokenCount } from './types';
import { parseModelId } from './modelId';

const VENDOR = 'integrity';

export { parseModelId };

function extractText(content: ReadonlyArray<unknown>): string {
	const chunks: string[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			chunks.push(part.value);
		} else if (typeof part === 'string') {
			chunks.push(part);
		}
	}
	return chunks.join('');
}

function extractToolCalls(content: ReadonlyArray<unknown>): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelToolCallPart) {
			const args = typeof part.input === 'object' && part.input
				? part.input as Record<string, unknown>
				: {};
			calls.push({ id: part.callId, name: part.name, arguments: args });
		}
	}
	return calls;
}

/**
 * Convert VS Code LM request messages into Integrity provider messages.
 */
export function vscodeMessagesToIntegrity(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): Message[] {
	const result: Message[] = [];

	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.System) {
			result.push({ role: 'system', content: extractText(message.content) });
			continue;
		}

		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const text = extractText(message.content);
			// Chat participants often send system instructions as a leading user message.
			if (text.startsWith('[System instructions]\n')) {
				result.push({ role: 'system', content: text.slice('[System instructions]\n'.length) });
				continue;
			}
		}

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCalls = extractToolCalls(message.content);
			result.push({
				role: 'assistant',
				content: extractText(message.content),
				toolCalls: toolCalls.length ? toolCalls : undefined,
			});
			continue;
		}

		// User role may contain tool results.
		const toolResults = message.content.filter(p => p instanceof vscode.LanguageModelToolResultPart) as vscode.LanguageModelToolResultPart[];
		if (toolResults.length) {
			for (const tr of toolResults) {
				result.push({
					role: 'tool',
					toolCallId: tr.callId,
					content: extractText(tr.content as unknown[]),
				});
			}
			const leftover = extractText(message.content);
			if (leftover.trim()) {
				result.push({ role: 'user', content: leftover });
			}
			continue;
		}

		result.push({ role: 'user', content: extractText(message.content) });
	}

	return result;
}

function vscodeToolsToIntegrity(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ToolDefinition[] | undefined {
	if (!tools?.length) {
		return undefined;
	}
	return tools.map(t => ({
		name: t.name,
		description: t.description,
		parameters: t.inputSchema as object | undefined,
	}));
}

/**
 * Integrity language model chat provider for the native model picker.
 */
export class IntegrityLanguageModelProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(private readonly router: ProviderRouter) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	notifyChanged(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const config = this.router.getConfig();
		const models: vscode.LanguageModelChatInformation[] = [];

		const ollama = this.router.getProvider('ollama');
		const ollamaOk = options.silent ? true : await ollama.testConnection();
		if (ollamaOk) {
			let names: string[] = [];
			try {
				names = (await ollama.listModels()).map(m => m.id);
			} catch {
				names = [];
			}
			if (!names.includes(config.ollama.chatModel)) {
				names.unshift(config.ollama.chatModel);
			}
			for (const name of names) {
				const isDefaultChat = name === config.ollama.chatModel && config.defaultProvider === 'ollama';
				models.push({
					id: `ollama:${name}`,
					name: `${name} (Ollama)`,
					family: 'ollama',
					version: '1',
					maxInputTokens: 32_768,
					maxOutputTokens: 8192,
					isDefault: isDefaultChat,
					isUserSelectable: true,
					capabilities: {
						toolCalling: true,
						editTools: ['find-replace', 'multi-find-replace'],
					},
					detail: 'Local via Ollama',
					tooltip: 'Local Integrity model via Ollama',
				} as vscode.LanguageModelChatInformation);
			}
		}

		if (config.cloudFallbackEnabled || config.defaultProvider === 'openai-compat') {
			if (config.openaiCompat.apiKey || !options.silent) {
				models.push({
					id: `openai-compat:${config.openaiCompat.model}`,
					name: `${config.openaiCompat.model} (OpenAI-compatible)`,
					family: 'openai-compat',
					version: '1',
					maxInputTokens: 128_000,
					maxOutputTokens: 16_384,
					isDefault: config.defaultProvider === 'openai-compat',
					isUserSelectable: true,
					isBYOK: true,
					capabilities: {
						toolCalling: true,
						editTools: ['find-replace', 'multi-find-replace'],
					},
					detail: 'BYOK OpenAI-compatible',
				} as vscode.LanguageModelChatInformation);
			}
		}

		if (config.cloudFallbackEnabled || config.defaultProvider === 'anthropic') {
			if (config.anthropic.apiKey || !options.silent) {
				models.push({
					id: `anthropic:${config.anthropic.model}`,
					name: `${config.anthropic.model} (Anthropic)`,
					family: 'anthropic',
					version: '1',
					maxInputTokens: 200_000,
					maxOutputTokens: 16_384,
					isDefault: config.defaultProvider === 'anthropic',
					isUserSelectable: true,
					isBYOK: true,
					capabilities: {
						toolCalling: true,
						editTools: ['find-replace', 'multi-find-replace'],
					},
					detail: 'BYOK Anthropic',
				} as vscode.LanguageModelChatInformation);
			}
		}

		return models;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const { providerId, model: modelName } = parseModelId(model.id);
		const provider = this.router.getProvider(providerId);
		const integrityMessages = vscodeMessagesToIntegrity(messages);
		const tools = vscodeToolsToIntegrity(options.tools);

		const abort = new AbortController();
		const subscription = token.onCancellationRequested(() => abort.abort());

		try {
			for await (const part of provider.chatParts(integrityMessages, {
				model: modelName,
				tools,
				toolChoice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
				signal: abort.signal,
			})) {
				if (token.isCancellationRequested) {
					break;
				}
				if (part.type === 'text') {
					progress.report(new vscode.LanguageModelTextPart(part.text));
				} else {
					progress.report(new vscode.LanguageModelToolCallPart(
						part.toolCall.id,
						part.toolCall.name,
						part.toolCall.arguments,
					));
				}
			}
		} finally {
			subscription.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === 'string') {
			return estimateTokenCount(text);
		}
		return estimateTokenCount(extractText(text.content));
	}
}

/**
 * Register the Integrity language model chat provider.
 */
export function registerLanguageModelProvider(
	context: vscode.ExtensionContext,
	router: ProviderRouter,
): IntegrityLanguageModelProvider {
	const provider = new IntegrityLanguageModelProvider(router);
	context.subscriptions.push(
		provider,
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('integrity.ai')) {
				provider.notifyChanged();
			}
		}),
	);

	return provider;
}

export { VENDOR as INTEGRITY_LM_VENDOR };
