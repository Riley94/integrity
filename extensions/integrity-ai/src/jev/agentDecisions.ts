/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { READ_ONLY_TOOLS } from '../agent/toolNames';
import type { ChoiceQuestion, JevAnswer, JevQuestion, JevState, NoulQuestion } from './jevClient';

export const TOOL_SURFACE_QUESTION = 'surface';
export const TOOL_SURFACE_NONE_QUESTION = 'none_suitable';
export const COMPLETION_QUESTION = 'status';

export const COMPLETION_UNVERIFIED_MESSAGE =
	'Completion could not be verified because Jev did not answer. Continue the task. Do not repeat the previous summary.';

export const COMPLETION_BLOCKED_MESSAGE =
	'This turn cannot be finished until Jev answers. Check integrity.ai.jev.apiKey and integrity.ai.jev.baseUrl, then try again.';

export interface JevThresholds {
	approvalThreshold: number;
	retrievalThreshold: number;
	completionConfidence: number;
	toolSurfaceConfidence: number;
}

/** Choice id for a text-only turn. Not a real tool name. */
export const TOOL_REPLY_CHOICE = 'reply';

export interface ToolSurfaceTool {
	name: string;
	description: string;
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
 * Options Jev may choose: text-only, then each real tool. An empty catalog offers nothing.
 * A tool literally named {@link TOOL_REPLY_CHOICE} is omitted so it cannot collide with text-only.
 */
export function offeredToolChoices(toolNames: readonly string[]): string[] {
	if (!toolNames.length) {
		return [];
	}
	return [TOOL_REPLY_CHOICE, ...toolNames.filter(name => name !== TOOL_REPLY_CHOICE)];
}

/**
 * Choice of exactly one tool, or reply for text only, plus a Noul for "none of these".
 * Returns undefined when there is no tool to choose.
 */
export function buildToolSurfaceRequest(
	prompt: string,
	mode: string,
	tools: readonly ToolSurfaceTool[],
): PreparedJevCall | undefined {
	const selectable = tools.filter(tool => tool.name !== TOOL_REPLY_CHOICE);
	const offered = offeredToolChoices(selectable.map(tool => tool.name));
	if (!offered.length) {
		return undefined;
	}
	const criteria: Record<string, string> = {
		[TOOL_REPLY_CHOICE]: 'Answer in text. Do not call a tool.',
	};
	for (const tool of selectable) {
		criteria[tool.name] = clip(tool.description, 400) || tool.name;
	}
	const choice: ChoiceQuestion = {
		type: 'choice',
		instructions: 'Which single option should the writer use for this turn? Choose reply when the task can be answered without a tool. Otherwise choose the one tool that should be called. The writer will not be allowed to call any other tool.',
		criteria,
	};
	const noneSuitable: NoulQuestion = {
		type: 'noul',
		instructions: 'Is none of these options suitable for this task?',
		criteria: {
			true: 'Neither a text answer nor any listed tool should be used',
			false: 'Reply or one listed tool is suitable',
		},
	};
	return {
		state: {
			task: clip(prompt, 8000),
			mode,
			tools: selectable.map(tool => ({
				name: tool.name,
				description: clip(tool.description, 400),
			})),
		},
		questions: {
			[TOOL_SURFACE_QUESTION]: choice,
			[TOOL_SURFACE_NONE_QUESTION]: noneSuitable,
		},
	};
}

/**
 * The one tool the writer may call, or undefined for a text-only turn.
 * Reply, a missing answer, low confidence, and an unknown id are all text-only.
 */
export function interpretToolSurface(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
}): string | undefined {
	const choice = selectedToolChoice(args);
	if (!choice || choice === TOOL_REPLY_CHOICE) {
		return undefined;
	}
	return choice;
}

/** Selected tool, or undefined when the writer must answer in text. */
export interface ToolSurfaceTrace {
	toolName: string | undefined;
	/** Reply explanation. The chat prints this only when `integrity.ai.jev.debug` is on. */
	text: string;
	/** State and questions sent to Jev, when a request was built. */
	request?: PreparedJevCall;
}

/**
 * Explain Jev's single-tool choice. The text includes the raw answer even when the turn stays text-only.
 * `toolName` matches {@link interpretToolSurface}.
 */
export function explainToolSurface(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
	toolNames: readonly string[];
}): ToolSurfaceTrace {
	if (!args.offered.length) {
		return {
			toolName: undefined,
			text: 'Jev tools\ndecision: text only (nothing to choose)',
		};
	}
	const toolName = interpretToolSurface(args);
	const lines = ['Jev tools', `offered: ${args.offered.join(', ')}`];
	const choice = args.answers?.[TOOL_SURFACE_QUESTION];
	const none = args.answers?.[TOOL_SURFACE_NONE_QUESTION];
	if (choice?.type === 'choice') {
		lines.push(`choice: ${choice.choice}`);
		lines.push(`confidence: ${formatScore(choice.confidence)}`);
		lines.push(`threshold: ${formatScore(args.toolSurfaceConfidence)}`);
		lines.push(`probabilities: ${formatProbabilities(choice.probabilities, args.offered)}`);
	}
	if (none?.type === 'noul') {
		lines.push(`none suitable: ${formatScore(none.noul)}`);
	}
	lines.push(`decision: ${toolChoiceDecision(args)}`);
	lines.push(`tool: ${toolName ?? 'none'}`);
	const withheld = args.toolNames.filter(name => name !== toolName && name !== TOOL_REPLY_CHOICE);
	lines.push(`withheld: ${formatNameList(withheld)}`);
	return { toolName, text: lines.join('\n') };
}

/** Shown when this turn does not ask Jev which ceiling to use. */
export function describeSkippedToolSurface(reason: string): string {
	return `Jev tools\ndecision: skipped (${reason})`;
}

/**
 * Chat dump of one tool-surface call: the state and questions that were sent, then the reply.
 * A skipped call has no request, so only the reply is included.
 */
export function formatToolSurfaceDebug(request: PreparedJevCall | undefined, reply: string): string {
	if (!request) {
		return reply;
	}
	return [
		'Jev request',
		`state:\n${debugJson(request.state)}`,
		`questions:\n${debugJson(request.questions)}`,
		'',
		reply,
	].join('\n');
}

function debugJson(value: unknown): string {
	const text = JSON.stringify(value, null, 2);
	return text ?? String(value);
}

/**
 * Human-readable host decision. A confident reply or a real tool name is applied.
 * Every other outcome leaves the writer with no tool.
 */
function toolChoiceDecision(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
}): string {
	if (args.unavailable || !args.answers) {
		return 'text only (Jev did not answer)';
	}
	const choice = args.answers[TOOL_SURFACE_QUESTION];
	const none = args.answers[TOOL_SURFACE_NONE_QUESTION];
	if (!choice || choice.type !== 'choice' || !none || none.type !== 'noul') {
		return 'text only (answer was missing a choice or a none-suitable score)';
	}
	if (choice.confidence < args.toolSurfaceConfidence) {
		return `text only (confidence ${formatScore(choice.confidence)} is below ${formatScore(args.toolSurfaceConfidence)})`;
	}
	if (none.noul >= args.toolSurfaceConfidence) {
		return `text only (none suitable ${formatScore(none.noul)} is at or above ${formatScore(args.toolSurfaceConfidence)})`;
	}
	if (!args.offered.includes(choice.choice)) {
		return `text only (choice ${choice.choice} was not offered)`;
	}
	if (choice.choice === TOOL_REPLY_CHOICE) {
		return 'text only (Jev chose reply)';
	}
	return `selected ${choice.choice}`;
}

/** The chosen id when it is confident and offered, including {@link TOOL_REPLY_CHOICE}. */
function selectedToolChoice(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
}): string | undefined {
	if (args.unavailable || !args.answers) {
		return undefined;
	}
	const choice = args.answers[TOOL_SURFACE_QUESTION];
	const none = args.answers[TOOL_SURFACE_NONE_QUESTION];
	if (!choice || choice.type !== 'choice' || !none || none.type !== 'noul') {
		return undefined;
	}
	if (choice.confidence < args.toolSurfaceConfidence) {
		return undefined;
	}
	if (none.noul >= args.toolSurfaceConfidence) {
		return undefined;
	}
	if (!args.offered.includes(choice.choice)) {
		return undefined;
	}
	return choice.choice;
}

/**
 * Reject a model tool call that is not the single tool Jev selected.
 * A text-only turn rejects every call.
 */
export function rejectionForUnselectedTool(toolName: string, selectedTool: string | undefined): string | undefined {
	if (!selectedTool) {
		return 'Tool error: this turn has no tool. Answer in text.';
	}
	if (toolName !== selectedTool) {
		return `Tool error: this turn may only call ${selectedTool}.`;
	}
	return undefined;
}

function formatScore(value: number): string {
	return value.toFixed(2);
}

function formatProbabilities(probabilities: Record<string, number>, offered: readonly string[]): string {
	const keys = [
		...offered.filter(name => Object.prototype.hasOwnProperty.call(probabilities, name)),
		...Object.keys(probabilities).filter(name => !offered.includes(name)).sort(),
	];
	if (!keys.length) {
		return 'none';
	}
	return keys.map(key => `${key} ${formatScore(probabilities[key])}`).join(', ');
}

function formatNameList(names: readonly string[]): string {
	return names.length ? names.join(', ') : 'none';
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
