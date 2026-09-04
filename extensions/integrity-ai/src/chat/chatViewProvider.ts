/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { getProviderConfig, type ProviderRouter } from '../providers/router';
import { ensureOllamaModelReady, isOllamaModelReady, ollamaModelNotReadyMessage } from '../ollama/ensureOllamaModel';
import type { Message } from '../providers/types';
import { ChatHistory } from './chatHistory';
import { CodebaseIndex } from '../indexing/indexManager';
import { AgentLoop } from '../agent/agentLoop';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'integrity.ai.chatView';

	private view?: vscode.WebviewView;
	private agentMode = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly router: ProviderRouter,
		private readonly history: ChatHistory,
		private readonly index: CodebaseIndex,
		private readonly agent: AgentLoop,
	) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'ready':
					this.postHistory();
					break;
				case 'send':
					await this.handleSend(msg.text, msg.mentions ?? []);
					break;
				case 'clear':
					await this.history.clear();
					this.postHistory();
					break;
				case 'toggleAgent':
					this.agentMode = !!msg.enabled;
					break;
				case 'openNativeChat':
					await vscode.commands.executeCommand('integrity.ai.openChat');
					break;
				case 'startOllama':
					await vscode.commands.executeCommand('integrity.ai.startOllama');
					break;
				case 'setupModels':
					await vscode.commands.executeCommand('integrity.ai.setupModels');
					break;
				case 'applyCode':
					await vscode.commands.executeCommand('integrity.ai.applyCodeBlock', msg.code, msg.language);
					break;
				case 'insertCode':
					await vscode.commands.executeCommand('integrity.ai.insertCodeBlock', msg.code);
					break;
			}
		});
	}

	focus(): void {
		this.view?.show?.(true);
	}

	toggleAgentMode(): void {
		this.agentMode = !this.agentMode;
		this.view?.webview.postMessage({ type: 'agentMode', enabled: this.agentMode });
	}

	private postHistory(): void {
		this.view?.webview.postMessage({
			type: 'history',
			messages: this.history.getAll(),
			agentMode: this.agentMode,
		});
	}

	private async handleSend(text: string, mentions: string[]): Promise<void> {
		if (!text.trim()) {
			return;
		}

		// Prefer native Chat for agent work.
		if (this.agentMode) {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				mode: 'agent',
				query: text,
			});
			return;
		}

		await this.history.add('user', text);
		this.view?.webview.postMessage({ type: 'userMessage', content: text });

		const contextBlocks = await this.resolveMentions(text, mentions);
		const systemPrompt = this.buildSystemPrompt(contextBlocks);

		try {
			if (this.agentMode) {
				const result = await this.agent.run(text, systemPrompt);
				const assistant = await this.history.add('assistant', result);
				this.view?.webview.postMessage({ type: 'assistantDone', message: assistant });
				return;
			}

			const provider = await this.router.getAvailableProvider();
			if (provider.id === 'ollama') {
				const model = getProviderConfig().ollama.chatModel;
				const result = await ensureOllamaModelReady(model);
				if (!isOllamaModelReady(result)) {
					this.view?.webview.postMessage({
						type: 'error',
						message: ollamaModelNotReadyMessage(model, result),
					});
					return;
				}
			}

			const messages: Message[] = [
				{ role: 'system', content: systemPrompt },
				...this.history.getAll().slice(-20).map(m => ({
					role: m.role as Message['role'],
					content: m.content,
				})),
			];

			const assistantMsg = await this.history.add('assistant', '');
			let full = '';

			for await (const chunk of provider.chat(messages)) {
				full += chunk;
				this.view?.webview.postMessage({ type: 'stream', content: chunk });
			}

			await this.history.update(assistantMsg.id, full);
			this.view?.webview.postMessage({ type: 'assistantDone', message: { ...assistantMsg, content: full } });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.view?.webview.postMessage({ type: 'error', message });
		}
	}

	private buildSystemPrompt(contextBlocks: string[]): string {
		const parts = [
			'You are Integrity AI, a helpful coding assistant built into Integrity IDE.',
			'Prefer concise, accurate answers. Use markdown code fences with language tags.',
			'When suggesting edits, show complete code blocks the user can apply.',
		];
		if (contextBlocks.length) {
			parts.push('\n--- Context ---\n', ...contextBlocks);
		}
		return parts.join('\n');
	}

	private async resolveMentions(text: string, mentions: string[]): Promise<string[]> {
		const blocks: string[] = [];
		const tags = new Set(mentions);

		if (tags.has('selection') || text.includes('@selection')) {
			const editor = vscode.window.activeTextEditor;
			if (editor && !editor.selection.isEmpty) {
				const sel = editor.document.getText(editor.selection);
				blocks.push(`### Selection (${path.basename(editor.document.fileName)})\n\`\`\`\n${sel}\n\`\`\``);
			}
		}

		if (tags.has('file') || text.includes('@file')) {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const content = editor.document.getText();
				blocks.push(`### File: ${editor.document.fileName}\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``);
			}
		}

		if (tags.has('folder') || text.includes('@folder')) {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder) {
				const tree = await this.listDir(folder.uri, 2);
				blocks.push(`### Workspace tree\n\`\`\`\n${tree}\n\`\`\``);
			}
		}

		if (tags.has('codebase') || text.includes('@codebase')) {
			const results = await this.index.search(text.replace(/@codebase/g, '').trim(), 8);
			for (const r of results) {
				blocks.push(`### ${r.path} (${r.startLine}-${r.endLine})\n\`\`\`\n${r.content}\n\`\`\``);
			}
		}

		return blocks;
	}

	private async listDir(uri: vscode.Uri, depth: number, prefix = ''): Promise<string> {
		if (depth <= 0) {
			return '';
		}
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const lines: string[] = [];
		for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
			if (name.startsWith('.') && name !== '.integrity') {
				continue;
			}
			lines.push(`${prefix}${name}${type === vscode.FileType.Directory ? '/' : ''}`);
			if (type === vscode.FileType.Directory) {
				const sub = await this.listDir(vscode.Uri.joinPath(uri, name), depth - 1, `${prefix}  `);
				if (sub) {
					lines.push(sub);
				}
			}
		}
		return lines.join('\n');
	}

	private getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="banner">
		<p><strong>Agentic coding</strong> now lives in the native Chat panel (Ask / Edit / Agent).</p>
		<div id="banner-actions">
			<button id="open-native">Open Chat (Agent)</button>
			<button id="start-ollama" class="secondary">Start Ollama</button>
			<button id="setup-models" class="secondary">Setup Models</button>
		</div>
	</div>
	<div id="messages"></div>
	<div id="input-area">
		<div id="mentions">
			<button class="mention" data-mention="file">@file</button>
			<button class="mention" data-mention="selection">@selection</button>
			<button class="mention" data-mention="folder">@folder</button>
			<button class="mention" data-mention="codebase">@codebase</button>
		</div>
		<textarea id="input" placeholder="Legacy status chat… prefer Open Chat above" rows="3"></textarea>
		<div id="toolbar">
			<label><input type="checkbox" id="agent-mode"> Agent mode (legacy)</label>
			<button id="clear">Clear</button>
			<button id="send">Send</button>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
