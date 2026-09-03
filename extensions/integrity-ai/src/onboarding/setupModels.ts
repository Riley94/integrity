/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getProviderConfig } from '../providers/router';

export async function setupRecommendedModels(): Promise<void> {
	const models = ['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'nomic-embed-text'];
	const cfg = getProviderConfig();
	const baseUrl = cfg.ollama.baseUrl.replace(/\/$/, '');

	const ok = await fetch(`${baseUrl}/api/tags`).then(r => r.ok).catch(() => false);
	if (!ok) {
		vscode.window.showErrorMessage(
			'Ollama is not running. Install from https://ollama.com and start the service.',
		);
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
		'Setup Models', 'Later',
	);

	if (choice === 'Setup Models') {
		await setupRecommendedModels();
	}

	await context.globalState.update('integrity.onboardingDone', true);
}
