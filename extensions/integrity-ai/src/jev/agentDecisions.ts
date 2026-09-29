/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { READ_ONLY_TOOLS } from '../agent/toolNames';
import type { ChoiceQuestion, JevAnswer, JevQuestion, JevState, NoulQuestion } from './jevClient';

export const ROUTING_MODEL_QUESTION = 'model';
export const ROUTING_NONE_QUESTION = 'none_suitable';
export const COMPLETION_QUESTION = 'status';

export const COMPLETION_UNVERIFIED_MESSAGE =
	'Completion could not be verified because Jev did not answer. Continue the task. Do not repeat the previous summary.';

export const COMPLETION_BLOCKED_MESSAGE =
	'This turn cannot be finished until Jev answers. Set integrity.ai.jev.apiKey and try again.';

export interface JevThresholds {
	approvalThreshold: number;
	routingConfidence: number;
	retrievalThreshold: number;
	completionConfidence: number;
}

export interface RoutingCandidate {
	id: string;
	name: string;
	family: string;
	maxInputTokens: number;
}

export interface RetrievalHit {
	path: string;
	content: string;
	startLine: number;
	endLine: number;
}

export interface ProposedToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface PreparedJevCall {
	state: JevState;
	questions: Record<string, JevQuestion>;
}

export type ApprovalAction = 'invoke' | 'prompt' | 'block';

export interface ApprovalVerdict {
	action: ApprovalAction;
	message: string;
}

export interface CompletionDecision {
	action: 'exit' | 'continue' | 'stop';
	message?: string;
	/** True when this decision is a missing Jev answer, not a typed verdict. */
	unavailable: boolean;
}

/**
 * Read-only Integrity tools skip the Jev approval gate. Every other tool is mutating.
 */
export function isMutatingTool(toolName: string): boolean {
	return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Terminal tools use `agent.requireTerminalApproval` as their confirmation floor.
 */
export function isTerminalTool(toolName: string): boolean {
	return /terminal/i.test(toolName);
}

export function retrievalQuestionId(index: number): string {
	return `chunk_${index}`;
}

export function approvalQuestionId(callId: string, index: number): string {
	return `${index}:${callId}`;
}

/**
 * Choice over allowlisted writer models, plus a Noul for "none of these".
 * Returns undefined when there is no candidate to choose.
 */
export function buildRoutingRequest(
	prompt: string,
	mode: string,
	currentModelId: string,
	candidates: readonly RoutingCandidate[],
): PreparedJevCall | undefined {
	if (!candidates.length) {
		return undefined;
	}
	const criteria: Record<string, string> = {};
	for (const candidate of candidates) {
		criteria[candidate.id] = `${candidate.name} (${candidate.family}, max input ${candidate.maxInputTokens} tokens)`;
	}
	const choice: ChoiceQuestion = {
		type: 'choice',
		instructions: 'Which candidate model should write this coding turn? Prefer quality, then context capacity.',
		criteria,
	};
	const noneSuitable: NoulQuestion = {
		type: 'noul',
		instructions: 'Is none of the candidate models suitable for this task?',
		criteria: {
			true: 'No candidate should write this turn',
			false: 'At least one candidate is suitable',
		},
	};
	return {
		state: {
			task: clip(prompt, 8000),
			mode,
			currentModelId,
			candidates: candidates.map(candidate => ({
				id: candidate.id,
				name: candidate.name,
				family: candidate.family,
				maxInputTokens: candidate.maxInputTokens,
				current: candidate.id === currentModelId,
			})),
		},
		questions: {
			[ROUTING_MODEL_QUESTION]: choice,
			[ROUTING_NONE_QUESTION]: noneSuitable,
		},
	};
}

/**
 * Switch only when Jev is confident, the chosen id is allowlisted, and "none suitable" is below the threshold.
 * Any failure keeps the user-selected model.
 */
export function interpretRouting(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	candidateIds: readonly string[];
	routingConfidence: number;
}): string | undefined {
	if (args.unavailable || !args.answers) {
		return undefined;
	}
	const choice = args.answers[ROUTING_MODEL_QUESTION];
	const none = args.answers[ROUTING_NONE_QUESTION];
	if (!choice || choice.type !== 'choice' || !none || none.type !== 'noul') {
		return undefined;
	}
	if (choice.confidence < args.routingConfidence) {
		return undefined;
	}
	if (none.noul >= args.routingConfidence) {
		return undefined;
	}
	if (!args.candidateIds.includes(choice.choice)) {
		return undefined;
	}
	return choice.choice;
}

/**
 * One Noul per chunk. A Score rates the whole state once, so it cannot rank a list.
 */
export function buildRetrievalRequest(query: string, hits: readonly RetrievalHit[]): PreparedJevCall | undefined {
	if (!hits.length) {
		return undefined;
	}
	const questions: Record<string, JevQuestion> = {};
	const chunks = hits.map((hit, index) => {
		const id = retrievalQuestionId(index);
		questions[id] = {
			type: 'noul',
			instructions: `Is chunk ${id} useful for the user task?`,
			criteria: {
				true: 'The chunk helps answer or carry out the task',
				false: 'The chunk is irrelevant to the task',
			},
		};
		return {
			id,
			path: hit.path,
			startLine: hit.startLine,
			endLine: hit.endLine,
			content: clip(hit.content, 1500),
		};
	});
	return {
		state: {
			task: clip(query, 4000),
			chunks,
		},
		questions,
	};
}

/**
 * Prefetch uses `drop-all` so a failed rank does not inject unranked chunks.
 * The search tool uses `keep-all` so a read still returns hits.
 */
export function interpretRetrieval(args: {
	hits: readonly RetrievalHit[];
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	threshold: number;
	onUnavailable: 'drop-all' | 'keep-all';
}): RetrievalHit[] {
	if (args.unavailable || !args.answers) {
		return args.onUnavailable === 'keep-all' ? [...args.hits] : [];
	}
	const kept: RetrievalHit[] = [];
	for (let index = 0; index < args.hits.length; index++) {
		const answer = args.answers[retrievalQuestionId(index)];
		if (answer?.type === 'noul' && answer.noul >= args.threshold) {
			kept.push(args.hits[index]);
		}
	}
	return kept;
}

export function formatRetrievedChunks(hits: readonly RetrievalHit[]): string {
	if (!hits.length) {
		return '';
	}
	const body = hits.map(hit =>
		`${hit.path}:${hit.startLine}-${hit.endLine}\n${clip(hit.content, 2000)}`,
	).join('\n\n---\n\n');
	const text = `Retrieved codebase excerpts:\n\n${body}`;
	return text.length > 12_000 ? text.slice(0, 12_000) : text;
}

/**
 * One Noul per mutating call: does this call need a human before it runs?
 */
export function buildApprovalRequest(calls: readonly ProposedToolCall[]): PreparedJevCall | undefined {
	if (!calls.length) {
		return undefined;
	}
	const questions: Record<string, JevQuestion> = {};
	const proposed = calls.map((call, index) => {
		const id = approvalQuestionId(call.id, index);
		questions[id] = {
			type: 'noul',
			instructions: `Does tool call ${id} need human approval before it runs? Consider side effects, reversibility, and scope.`,
			criteria: {
				true: 'A person should confirm this call before it runs',
				false: 'The call is safe to run without an extra confirmation',
			},
		};
		return {
			id,
			name: call.name,
			arguments: clipJson(call.input, 4000),
		};
	});
	return {
		state: { calls: proposed },
		questions,
	};
}

/**
 * A missing Jev answer blocks the call. A configured approval floor cannot be skipped by a low Noul.
 */
export function interpretApproval(args: {
	toolName: string;
	answer: JevAnswer | undefined;
	unavailable: boolean;
	approvalThreshold: number;
	requireEditApproval: boolean;
	requireTerminalApproval: boolean;
}): ApprovalVerdict {
	if (args.unavailable || !args.answer || args.answer.type !== 'noul') {
		return {
			action: 'block',
			message: blockedMutatingToolMessage(args.toolName),
		};
	}
	const floor = isTerminalTool(args.toolName) ? args.requireTerminalApproval : args.requireEditApproval;
	if (floor || args.answer.noul >= args.approvalThreshold) {
		return { action: 'prompt', message: '' };
	}
	return { action: 'invoke', message: '' };
}

export function blockedMutatingToolMessage(toolName: string): string {
	return `Tool error: mutating tool ${toolName} was blocked because Jev did not answer.`;
}

export function buildCompletionRequest(task: string, assistantText: string): PreparedJevCall {
	const choice: ChoiceQuestion = {
		type: 'choice',
		instructions: 'Is this coding turn complete? Judge the objective against the assistant reply. Do not treat an unverified claim as done.',
		criteria: {
			complete: 'The task is done and the reply is sufficient',
			verify_more: 'More verification is needed before reporting success',
			incomplete: 'The task is not finished',
		},
	};
	return {
		state: {
			task: clip(task, 8000),
			assistantText: clip(assistantText, 8000),
		},
		questions: {
			[COMPLETION_QUESTION]: choice,
		},
	};
}

/**
 * Exit only on a confident `complete`. The first missing answer continues once; the next missing answer stops.
 */
export function interpretCompletion(args: {
	answer: JevAnswer | undefined;
	unavailable: boolean;
	completionConfidence: number;
	priorUnavailable: boolean;
}): CompletionDecision {
	if (args.unavailable || !args.answer || args.answer.type !== 'choice') {
		if (args.priorUnavailable) {
			return {
				action: 'stop',
				message: COMPLETION_BLOCKED_MESSAGE,
				unavailable: true,
			};
		}
		return {
			action: 'continue',
			message: COMPLETION_UNVERIFIED_MESSAGE,
			unavailable: true,
		};
	}

	const choice = args.answer.choice;
	if (choice === 'complete' && args.answer.confidence >= args.completionConfidence) {
		return { action: 'exit', unavailable: false };
	}

	const reason = choice === 'complete'
		? 'complete with low confidence'
		: choice;
	return {
		action: 'continue',
		message: `Jev marked this turn as ${reason}. Continue the task. Do not repeat the previous summary.`,
		unavailable: false,
	};
}

function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, max) + '…';
}

function clipJson(value: unknown, max: number): unknown {
	try {
		const text = JSON.stringify(value);
		if (text === undefined) {
			return null;
		}
		if (text.length <= max) {
			return value;
		}
		return text.slice(0, max) + '…';
	} catch {
		return String(value).slice(0, max);
	}
}
