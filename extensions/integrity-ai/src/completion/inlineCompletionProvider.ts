/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderRouter } from '../providers/router';
import type { CodebaseIndex } from '../indexing/indexManager';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingAbort = new Map<string, AbortController>();
	private cache = new Map<string, string>();

	constructor(
		private readonly router: ProviderRouter,
		private readonly index: CodebaseIndex,
	) { }

	provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
		const config = vscode.workspace.getConfiguration('integrity.ai');
		if (!config.get<boolean>('inlineCompletions.enabled', true)) {
			return [];
		}

		const key = document.uri.toString();

		return new Promise(resolve => {
			clearTimeout(this.debounceTimers.get(key));
			this.pendingAbort.get(key)?.abort();

			this.debounceTimers.set(key, setTimeout(async () => {
				if (token.isCancellationRequested) {
					resolve([]);
					return;
				}

				try {
					const item = await this.fetchCompletion(document, position);
					resolve(item ? [item] : []);
				} catch {
					resolve([]);
				}
			}, 300));
		});
	}

	private async fetchCompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.InlineCompletionItem | undefined> {
		const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const suffix = document.getText(new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end));
		const cacheKey = `${document.uri.fsPath}:${position.line}:${position.character}:${prefix.slice(-200)}`;

		if (this.cache.has(cacheKey)) {
			const text = this.cache.get(cacheKey)!;
			return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
		}

		const abort = new AbortController();
		this.pendingAbort.set(document.uri.toString(), abort);

		const provider = await this.router.getAvailableProvider();
		const cfg = vscode.workspace.getConfiguration('integrity.ai');
		const completionModel = cfg.get<string>('ollama.completionModel', 'qwen2.5-coder:7b');

		let relatedContext = '';
		try {
			const lastLine = document.lineAt(position.line).text;
			const results = await this.index.search(lastLine, 2);
			relatedContext = results.map(r => r.content).join('\n');
		} catch {
			// index optional for completions
		}

		const prompt = [
			'Complete the code at the cursor. Output ONLY the completion text, no markdown fences.',
			relatedContext ? `Related code:\n${relatedContext}\n` : '',
			`File: ${document.fileName}`,
			'```',
			prefix,
			'<CURSOR>',
			suffix.slice(0, 500),
			'```',
		].join('\n');

		let completion = '';
		for await (const chunk of provider.complete(prompt, {
			model: completionModel,
			maxTokens: 256,
			signal: abort.signal,
		})) {
			completion += chunk;
		}

		completion = completion.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
		if (!completion || completion.length < 2) {
			return undefined;
		}

		this.cache.set(cacheKey, completion);
		if (this.cache.size > 50) {
			const first = this.cache.keys().next().value;
			if (first) {
				this.cache.delete(first);
			}
		}

		return new vscode.InlineCompletionItem(completion, new vscode.Range(position, position));
	}
}
