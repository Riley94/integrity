/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Headless SWE-bench switches. Set only by the smoke runner.
 * A normal IDE session leaves this unset, so approval floors and install prompts stay as configured.
 */

/** `1` enables the smoke-run path in the extension host. */
export const SWEBENCH_ENV = 'INTEGRITY_SWEBENCH';

/** Absolute path to the problem statement. Lives outside the task repo. */
export const SWEBENCH_PROMPT_FILE_ENV = 'INTEGRITY_SWEBENCH_PROMPT_FILE';

/** Absolute path for the turn status JSON. Lives outside the task repo. */
export const SWEBENCH_STATUS_FILE_ENV = 'INTEGRITY_SWEBENCH_STATUS_FILE';

/** Language model id passed to `workbench.action.chat.open`. */
export const SWEBENCH_MODEL_ENV = 'INTEGRITY_SWEBENCH_MODEL';

/** Default writer for the smoke run. Matches the Ollama chat model id the provider publishes. */
export const DEFAULT_SWEBENCH_MODEL_ID = 'ollama:qwen2.5-coder:14b';

export const SWEBENCH_MODEL_VENDOR = 'integrity';

export interface ApprovalFloorSettings {
	requireEditApproval: boolean;
	requireTerminalApproval: boolean;
}

export interface BenchmarkChatOpenArgs {
	mode: 'agent';
	query: string;
	blockOnResponse: true;
	modelSelector: { vendor: typeof SWEBENCH_MODEL_VENDOR; id: string };
}

export interface BenchmarkStatus {
	outcome: 'completed' | 'error';
	message?: string;
}

/**
 * True when this window was launched by the SWE-bench smoke runner.
 */
export function isSweBenchBenchmark(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SWEBENCH_ENV] === '1';
}

/**
 * Approval floors for mutating tools.
 * The smoke run clears both floors so a Jev Noul under the threshold can invoke without a modal.
 * A Noul at or above the threshold still prompts. A missing Jev answer still blocks.
 */
export function approvalFloors(settings: ApprovalFloorSettings, benchmark: boolean): ApprovalFloorSettings {
	if (benchmark) {
		return { requireEditApproval: false, requireTerminalApproval: false };
	}
	return {
		requireEditApproval: settings.requireEditApproval,
		requireTerminalApproval: settings.requireTerminalApproval,
	};
}

/**
 * Whether the first-launch Ollama welcome modal should appear.
 * The smoke profile is fresh, so the modal would block the turn. Skip it without marking onboarding done.
 */
export function shouldRunOnboarding(seen: boolean, benchmark: boolean): boolean {
	return !benchmark && !seen;
}

/**
 * Whether a missing Ollama model should skip the install confirm.
 * Declining ends the turn with the existing not-installed message instead of hanging on a modal.
 */
export function shouldDeclineOllamaInstall(benchmark: boolean): boolean {
	return benchmark;
}

/**
 * Arguments for one Agent-mode turn. `query` is the problem statement and nothing else.
 */
export function benchmarkChatOpenArgs(prompt: string, modelId: string): BenchmarkChatOpenArgs {
	return {
		mode: 'agent',
		query: prompt,
		blockOnResponse: true,
		modelSelector: {
			vendor: SWEBENCH_MODEL_VENDOR,
			id: modelId,
		},
	};
}

/**
 * Status written when the chat command returns. A missing file means the runner timed out.
 */
export function benchmarkStatus(outcome: BenchmarkStatus['outcome'], message?: string): BenchmarkStatus {
	if (message) {
		return { outcome, message };
	}
	return { outcome };
}
