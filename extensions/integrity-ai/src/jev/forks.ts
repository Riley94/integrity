/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	type ApprovalVerdict,
	type CompletionDecision,
	type CompletionToolCall,
	type JevThresholds,
	type PreparedJevCall,
	type ProposedToolCall,
	type RetrievalHit,
	type ToolSurfaceTool,
	COMPLETION_QUESTION,
	approvalQuestionId,
	buildApprovalRequest,
	buildCompletionRequest,
	buildRetrievalRequest,
	buildToolSurfaceRequest,
	explainCompletion,
	explainToolSurface,
	interpretApproval,
	interpretRetrieval,
	offeredToolChoices,
	type ToolSurfaceTrace,
} from './agentDecisions';
import {
	type JevAnswer,
	type JevClientConfig,
	JEV_DEFAULT_BASE_URL,
	evaluateJev,
	isAbortError,
} from './jevClient';

export interface JevRuntime {
	config: JevClientConfig;
	thresholds: JevThresholds;
	requireEditApproval: boolean;
	requireTerminalApproval: boolean;
}

/**
 * Read Jev and approval settings. Thresholds are clamped to 0..1.
 */
export function readJevRuntime(): JevRuntime {
	const cfg = vscode.workspace.getConfiguration('integrity.ai');
	return {
		config: {
			apiKey: cfg.get<string>('jev.apiKey', ''),
			baseUrl: cfg.get<string>('jev.baseUrl', JEV_DEFAULT_BASE_URL),
			model: cfg.get<string>('jev.model', 'jev-latest'),
		},
		thresholds: {
			approvalThreshold: unit(cfg.get<number>('jev.approvalThreshold', 0.7), 0.7),
			retrievalThreshold: unit(cfg.get<number>('jev.retrievalThreshold', 0.5), 0.5),
			completionConfidence: unit(cfg.get<number>('jev.completionConfidence', 0.6), 0.6),
			toolSurfaceConfidence: unit(cfg.get<number>('jev.toolSurfaceConfidence', 0.5), 0.5),
		},
		requireEditApproval: cfg.get<boolean>('agent.requireEditApproval', true),
		requireTerminalApproval: cfg.get<boolean>('agent.requireTerminalApproval', true),
	};
}

/**
 * The tools for this turn. An empty list is text only.
 * A missing key or a failed call withholds every tool. A Noul under the threshold withholds that tool.
 * Reply at or above the threshold, and at least as high as every tool, withholds every tool.
 * `text` is the raw answer and that decision. `request` is the state and questions that were sent.
 */
export async function routeToolSurface(
	prompt: string,
	mode: string,
	tools: readonly ToolSurfaceTool[],
	signal?: AbortSignal,
): Promise<ToolSurfaceTrace> {
	const toolNames = tools.map(tool => tool.name);
	const offered = offeredToolChoices(toolNames);
	const request = buildToolSurfaceRequest(prompt, mode, tools);
	if (!request) {
		return explainToolSurface({
			answers: undefined,
			unavailable: true,
			offered,
			toolSurfaceConfidence: 0,
			toolNames,
		});
	}
	const { config, thresholds } = readJevRuntime();
	const answers = await evaluateOrUnavailable(config, request, signal);
	const trace = explainToolSurface({
		answers: answers ?? undefined,
		unavailable: answers === null,
		offered,
		toolSurfaceConfidence: thresholds.toolSurfaceConfidence,
		toolNames,
	});
	for (const line of trace.text.split('\n')) {
		logJev(line);
	}
	return { ...trace, request };
}

/**
 * Rank index hits. `drop-all` injects nothing when Jev does not answer.
 * `keep-all` returns the original hits so a read tool still succeeds.
 */
export async function rankChunksForContext(
	query: string,
	hits: readonly RetrievalHit[],
	onUnavailable: 'drop-all' | 'keep-all',
	signal?: AbortSignal,
): Promise<RetrievalHit[]> {
	const request = buildRetrievalRequest(query, hits);
	if (!request) {
		return [];
	}
	const { config, thresholds } = readJevRuntime();
	const answers = await evaluateOrUnavailable(config, request, signal);
	return interpretRetrieval({
		hits,
		answers: answers ?? undefined,
		unavailable: answers === null,
		threshold: thresholds.retrievalThreshold,
		onUnavailable,
	});
}

/**
 * One verdict per mutating call, keyed by {@link approvalQuestionId}.
 * An unanswered call is a block.
 */
export async function judgeMutatingCalls(
	calls: readonly ProposedToolCall[],
	signal?: AbortSignal,
): Promise<Map<string, ApprovalVerdict>> {
	const verdicts = new Map<string, ApprovalVerdict>();
	const request = buildApprovalRequest(calls);
	if (!request) {
		return verdicts;
	}
	const runtime = readJevRuntime();
	const answers = await evaluateOrUnavailable(runtime.config, request, signal);
	const unavailable = answers === null;
	calls.forEach((call, index) => {
		const key = approvalQuestionId(call.id, index);
		verdicts.set(key, interpretApproval({
			toolName: call.name,
			answer: answers?.[key],
			unavailable: unavailable || !answers?.[key],
			approvalThreshold: runtime.thresholds.approvalThreshold,
			requireEditApproval: runtime.requireEditApproval,
			requireTerminalApproval: runtime.requireTerminalApproval,
		}));
	});
	return verdicts;
}

/** Completion decision plus the state, questions, and reply for debug output. */
export interface CompletionCheck {
	decision: CompletionDecision;
	request: PreparedJevCall;
	text: string;
}

/**
 * Decide whether a text-only assistant reply may end the turn.
 * `toolCalls` are the invocations already made on this turn; they go into the state with the task and reply.
 * `request` is the state and questions that were sent. `text` is the raw answer and that decision.
 */
export async function judgeCompletion(
	task: string,
	assistantText: string,
	toolCalls: readonly CompletionToolCall[],
	priorUnavailable: boolean,
	signal?: AbortSignal,
): Promise<CompletionCheck> {
	const request = buildCompletionRequest(task, assistantText, toolCalls);
	const { config, thresholds } = readJevRuntime();
	const answers = await evaluateOrUnavailable(config, request, signal);
	const answer = answers?.[COMPLETION_QUESTION];
	const explained = explainCompletion({
		answer,
		unavailable: answers === null || !answer,
		completionConfidence: thresholds.completionConfidence,
		priorUnavailable,
	});
	return { ...explained, request };
}

/**
 * Link a VS Code cancellation token to an abort signal for one Jev call.
 */
export function beginCancellation(token: vscode.CancellationToken): { signal: AbortSignal; end: () => void } {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const subscription = token.onCancellationRequested(() => controller.abort());
	return {
		signal: controller.signal,
		end: () => subscription.dispose(),
	};
}

/**
 * @returns parsed answers, or null when Jev is unset or the call failed.
 * Abort errors propagate.
 */
async function evaluateOrUnavailable(
	config: JevClientConfig,
	request: PreparedJevCall,
	signal: AbortSignal | undefined,
): Promise<Record<string, JevAnswer> | null> {
	try {
		const result = await evaluateJev(config, request.state, request.questions, { signal });
		logJev(`${result.model} answered ${Object.keys(result.answers).length} question(s).`);
		return result.answers;
	} catch (err) {
		if (isAbortError(err)) {
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		logJev(`${message} (${config.baseUrl})`);
		return null;
	}
}

let output: vscode.OutputChannel | undefined;

/** Append a Jev diagnostic. Does not log keys, state, or question payloads. */
function logJev(message: string): void {
	if (!output) {
		output = vscode.window.createOutputChannel('Integrity AI');
	}
	output.appendLine(`[Jev] ${message}`);
}

function unit(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(1, Math.max(0, value));
}
