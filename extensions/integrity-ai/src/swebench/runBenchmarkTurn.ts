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
 * No-op unless {@link isSweBenchBenchmark} is set. Call this after the codebase index is ready.
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
		await vscode.commands.executeCommand(
			'workbench.action.chat.open',
			benchmarkChatOpenArgs(prompt, modelId),
		);
		await writeBenchmarkStatus(statusFile, benchmarkStatus('completed'));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (statusFile) {
			await writeBenchmarkStatus(statusFile, benchmarkStatus('error', message));
		}
	} finally {
		await vscode.commands.executeCommand('workbench.action.quit');
	}
}

async function writeBenchmarkStatus(statusFile: string, status: ReturnType<typeof benchmarkStatus>): Promise<void> {
	await writeFile(statusFile, JSON.stringify(status), 'utf8');
}
