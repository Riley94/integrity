/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
	DEFAULT_SWEBENCH_MODEL_ID,
	SWEBENCH_MODEL_ENV,
	SWEBENCH_PROMPT_FILE_ENV,
	SWEBENCH_STATUS_FILE_ENV,
	benchmarkChatOpenArgs,
	benchmarkStatus,
	isSweBenchBenchmark,
} from './benchmarkMode';

/**
 * Submit the smoke-run problem statement in Agent mode, record the outcome, and quit.
 * No-op unless {@link isSweBenchBenchmark} is set.
 * The runner kills the window if this never writes the status file.
 */
export async function runBenchmarkTurn(): Promise<void> {
	if (!isSweBenchBenchmark()) {
		return;
	}

	const promptFile = process.env[SWEBENCH_PROMPT_FILE_ENV];
	const statusFile = process.env[SWEBENCH_STATUS_FILE_ENV];
	const modelId = process.env[SWEBENCH_MODEL_ENV] || DEFAULT_SWEBENCH_MODEL_ID;

	try {
		if (!promptFile || !statusFile) {
			throw new Error(`${SWEBENCH_PROMPT_FILE_ENV} and ${SWEBENCH_STATUS_FILE_ENV} are required.`);
		}
		const prompt = await readFile(promptFile, 'utf8');
		if (!prompt.trim()) {
			throw new Error(`Benchmark prompt file is empty: ${promptFile}`);
		}
		console.log('[integrity-ai] SWE-bench turn starting');
		await vscode.commands.executeCommand(
			'workbench.action.chat.open',
			benchmarkChatOpenArgs(prompt, modelId),
		);
		await writeBenchmarkStatus(statusFile, benchmarkStatus('completed'));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`[integrity-ai] SWE-bench turn failed: ${message}`);
		if (statusFile) {
			await writeBenchmarkStatus(statusFile, benchmarkStatus('error', message));
		}
	} finally {
		await vscode.commands.executeCommand('workbench.action.quit');
	}
}

/**
 * Start the smoke turn after this extension's activate() returns.
 * Awaiting the chat command inside activate() never delivers it: the participant
 * handler cannot run until activation finishes.
 */
export function scheduleBenchmarkTurn(): void {
	if (!isSweBenchBenchmark()) {
		return;
	}
	setTimeout(() => {
		void runBenchmarkTurn();
	}, 0);
}

async function writeBenchmarkStatus(statusFile: string, status: ReturnType<typeof benchmarkStatus>): Promise<void> {
	await writeFile(statusFile, JSON.stringify(status), 'utf8');
}
