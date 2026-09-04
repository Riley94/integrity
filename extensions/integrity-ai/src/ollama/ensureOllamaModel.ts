/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getProviderConfig } from '../providers/router';
import { startOllamaFromIde } from '../onboarding/setupModels';
import { normalizeOllamaBaseUrl, probeOllama } from './ollamaServer';
import {
	ensureOllamaModelInstalled,
	installPromptCopy,
	isOllamaModelReady,
	listInstalledOllamaModels,
	lookupOllamaModelSize,
	normalizeOllamaModelName,
	pullOllamaModel,
	type EnsureOllamaModelDeps,
	type EnsureOllamaModelResult,
} from './ollamaModels';

export { isOllamaModelReady, ollamaModelNotReadyMessage } from './ollamaModels';

const inFlight = new Map<string, Promise<EnsureOllamaModelResult>>();
const confirmedInstalled = new Set<string>();

/**
 * Ensure the selected Ollama model is installed, prompting with disk size when it is not.
 *
 * Concurrent callers for the same model share one prompt/pull.
 */
export async function ensureOllamaModelReady(model: string): Promise<EnsureOllamaModelResult> {
	const key = normalizeOllamaModelName(model);
	if (confirmedInstalled.has(key)) {
		return { status: 'already-installed' };
	}

	const existing = inFlight.get(key);
	if (existing) {
		return existing;
	}

	const run = ensureOllamaModelInstalled(
		model,
		normalizeOllamaBaseUrl(getProviderConfig().ollama.baseUrl),
		vscodeEnsureDeps,
	).then(result => {
		if (isOllamaModelReady(result)) {
			confirmedInstalled.add(key);
		}
		if (result.status === 'installed') {
			vscode.window.showInformationMessage(`Integrity: Installed ${model}.`);
		}
		return result;
	});

	inFlight.set(key, run);
	try {
		return await run;
	} finally {
		inFlight.delete(key);
	}
}

/**
 * When the user picks Ollama (or changes the chat model), offer to install a missing model.
 */
export function registerOllamaModelInstallPrompt(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('integrity.ai.defaultProvider')
				|| e.affectsConfiguration('integrity.ai.ollama.chatModel')
			) {
				const config = getProviderConfig();
				if (config.defaultProvider === 'ollama') {
					void ensureOllamaModelReady(config.ollama.chatModel);
				}
			}
		}),
	);
}

const vscodeEnsureDeps: EnsureOllamaModelDeps = {
	ensureServer: async () => {
		const baseUrl = normalizeOllamaBaseUrl(getProviderConfig().ollama.baseUrl);
		return await probeOllama(baseUrl) || await startOllamaFromIde({ silentIfRunning: true });
	},
	listInstalled: baseUrl => listInstalledOllamaModels(baseUrl),
	lookupSize: model => lookupOllamaModelSize(model),
	pull: (baseUrl, model, onProgress, signal) => pullOllamaModel(baseUrl, model, { onProgress, signal }),
	promptInstall: async (model, sizeBytes) => {
		const { message, detail } = installPromptCopy(model, sizeBytes);
		const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Install');
		return choice === 'Install';
	},
	withProgress: async (title, task) => {
		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title,
			cancellable: true,
		}, async (progress, token) => {
			const abort = new AbortController();
			const sub = token.onCancellationRequested(() => abort.abort());
			try {
				return await task(message => progress.report({ message }), abort.signal);
			} finally {
				sub.dispose();
			}
		});
	},
	showError: message => {
		void vscode.window.showErrorMessage(message);
	},
};
