/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getProviderConfig } from '../providers/router';
import {
	createDefaultOllamaDeps,
	ensureOllamaRunning,
	normalizeOllamaBaseUrl,
	probeOllama,
	type EnsureOllamaResult,
} from '../ollama/ollamaServer';

const OLLAMA_INSTALL_URL = 'https://ollama.com';

/**
 * Start a local Ollama server from the IDE when it is not already reachable.
 *
 * @param options.silentIfRunning When true, skip the "already running" toast
 * (used by Setup Models, which continues into a pull).
 * @returns true when Ollama is reachable afterwards.
 */
export async function startOllamaFromIde(options?: { silentIfRunning?: boolean }): Promise<boolean> {
	const baseUrl = normalizeOllamaBaseUrl(getProviderConfig().ollama.baseUrl);

	const result = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Integrity: Starting Ollama',
		cancellable: false,
	}, async () => ensureOllamaRunning(baseUrl, createDefaultOllamaDeps()));

	return presentEnsureResult(result, options?.silentIfRunning === true);
}

export async function setupRecommendedModels(): Promise<void> {
	const models = ['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'nomic-embed-text'];
	const baseUrl = normalizeOllamaBaseUrl(getProviderConfig().ollama.baseUrl);

	const reachable = await probeOllama(baseUrl) || await startOllamaFromIde({ silentIfRunning: true });
	if (!reachable) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Integrity: Pulling recommended models',
		cancellable: false,
	}, async () => {
		for (const model of models) {
			await fetch(`${baseUrl}/api/pull`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: model }),
			});
		}
	});

	vscode.window.showInformationMessage('Integrity: Recommended models pull started in Ollama.');
}

export async function runOnboarding(context: vscode.ExtensionContext): Promise<void> {
	const seen = context.globalState.get<boolean>('integrity.onboardingDone');
	if (seen) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Welcome to Integrity IDE! Set up local AI models with Ollama?',
		'Setup Models', 'Start Ollama', 'Later',
	);

	if (choice === 'Setup Models') {
		await setupRecommendedModels();
	} else if (choice === 'Start Ollama') {
		await startOllamaFromIde();
	}

	await context.globalState.update('integrity.onboardingDone', true);
}

async function presentEnsureResult(result: EnsureOllamaResult, silentIfRunning: boolean): Promise<boolean> {
	switch (result.status) {
		case 'already-running':
			if (!silentIfRunning) {
				vscode.window.showInformationMessage('Ollama is already running.');
			}
			return true;
		case 'started':
			vscode.window.showInformationMessage('Ollama started.');
			return true;
		case 'not-local':
			vscode.window.showErrorMessage(
				`Cannot start Ollama at ${result.baseUrl} from this machine. Start that server, or set integrity.ai.ollama.baseUrl to a local URL.`,
			);
			return false;
		case 'not-installed': {
			const install = await vscode.window.showErrorMessage(
				'Ollama is not installed. Install it from ollama.com, then start it from Integrity.',
				'Open ollama.com',
			);
			if (install) {
				await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_INSTALL_URL));
			}
			return false;
		}
		case 'start-failed':
			vscode.window.showErrorMessage(`Failed to start Ollama: ${result.message}`);
			return false;
		case 'timed-out':
			vscode.window.showErrorMessage(
				'Ollama did not become ready in time. Confirm the CLI works (`ollama serve`) and that integrity.ai.ollama.baseUrl matches the bind address.',
			);
			return false;
	}
}
