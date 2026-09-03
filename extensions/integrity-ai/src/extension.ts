/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ChatHistory } from './chat/chatHistory';
import { getProviderConfig, ProviderRouter } from './providers/router';
import { CodebaseIndex } from './indexing/indexManager';
import { AgentLoop } from './agent/agentLoop';
import { InlineCompletionProvider } from './completion/inlineCompletionProvider';
import { runOnboarding, setupRecommendedModels } from './onboarding/setupModels';
import { registerAgentDiffProvider } from './agent/diffProvider';

let chatProvider: ChatViewProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const config = getProviderConfig();
	const router = new ProviderRouter(config);
	const history = new ChatHistory(context);
	const index = new CodebaseIndex(router);
	const agent = new AgentLoop(router, index);

	chatProvider = new ChatViewProvider(context, router, history, index, agent);

	registerAgentDiffProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			new InlineCompletionProvider(router, index),
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('integrity.ai.openChat', () => {
			vscode.commands.executeCommand('integrity.ai.chatView.focus');
		}),
		vscode.commands.registerCommand('integrity.ai.testConnection', () => testConnection(router)),
		vscode.commands.registerCommand('integrity.ai.setupModels', () => setupRecommendedModels()),
		vscode.commands.registerCommand('integrity.ai.reindexCodebase', () => reindex(index)),
		vscode.commands.registerCommand('integrity.ai.toggleAgentMode', () => chatProvider.toggleAgentMode()),
		vscode.commands.registerCommand('integrity.ai.applyCodeBlock', (code: string, _language?: string) => applyCode(code)),
		vscode.commands.registerCommand('integrity.ai.insertCodeBlock', (code: string) => insertCode(code)),
	);

	await index.initialize(context);
	await runOnboarding(context);

	const output = vscode.window.createOutputChannel('Integrity AI');
	context.subscriptions.push(output);
	output.appendLine('Integrity AI extension activated.');
}

export function deactivate(): void {
	// cleanup handled by subscriptions
}

async function testConnection(router: ProviderRouter): Promise<void> {
	const channel = vscode.window.createOutputChannel('Integrity AI');
	channel.show(true);
	channel.appendLine('Testing model connections...\n');

	for (const id of ['ollama', 'openai-compat', 'anthropic'] as const) {
		const provider = router.getProvider(id);
		const ok = await provider.testConnection();
		channel.appendLine(`${id}: ${ok ? 'OK' : 'FAILED'}`);

		if (ok) {
			channel.appendLine('Streaming test response:');
			for await (const chunk of provider.chat([
				{ role: 'user', content: 'Reply with exactly: Integrity AI connected.' },
			], { maxTokens: 32 })) {
				channel.append(chunk);
			}
			channel.appendLine('\n');
		}
	}

	vscode.window.showInformationMessage('Integrity: Model connection test complete. See output panel.');
}

async function reindex(index: CodebaseIndex): Promise<void> {
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Integrity: Reindexing codebase',
		cancellable: false,
	}, async () => {
		await index.reindex();
	});
	vscode.window.showInformationMessage('Integrity: Codebase reindexed.');
}

async function applyCode(code: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor.');
		return;
	}
	const fullRange = new vscode.Range(
		editor.document.positionAt(0),
		editor.document.positionAt(editor.document.getText().length),
	);
	await editor.edit(editBuilder => editBuilder.replace(fullRange, code));
}

async function insertCode(code: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor.');
		return;
	}
	await editor.edit(editBuilder => editBuilder.insert(editor.selection.active, code));
}
