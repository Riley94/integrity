/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { READ_ONLY_TOOLS } from '../agent/toolNames';
import type { JevAnswer, JevQuestion, JevState } from './jevClient';

/** Choice id for a text-only turn. Not a real tool name. */
export const TOOL_REPLY_CHOICE = 'reply';

/**
 * How far a tool Noul must outscore reply before the turn leaves text.
 * A smaller lead is the same uncertain reading, so reply still wins.
 */
export const TOOL_SURFACE_REPLY_MARGIN = 0.05;

export interface JevThresholds {
	retrievalThreshold: number;
	toolSurfaceConfidence: number;
}

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

export interface PreparedJevCall {
	state: JevState;
	questions: Record<string, JevQuestion>;
}

/**
 * Read-only Integrity tools run without a confirmation dialog. Every other tool is mutating.
 */
export function isMutatingTool(toolName: string): boolean {
	return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Terminal tools use `agent.requireTerminalApproval`. Other mutating tools use `agent.requireEditApproval`.
 */
export function isTerminalTool(toolName: string): boolean {
	return /terminal/i.test(toolName);
}

/**
 * Whether this mutating call waits for the user.
 * Confirmation is the security setting for that tool kind. Jev does not score it.
 */
export function mutatingToolNeedsConfirmation(
	toolName: string,
	requireEditApproval: boolean,
	requireTerminalApproval: boolean,
): boolean {
	return isTerminalTool(toolName) ? requireTerminalApproval : requireEditApproval;
}

export function retrievalQuestionId(index: number): string {
	return `chunk_${index}`;
}

/** Question id for one offered tool. The id is the tool name. */
export function toolSurfaceQuestionId(toolName: string): string {
	return toolName;
}

/**
 * Options Jev may score: text-only, then each real tool.
 * Blank names and duplicates are dropped. An empty catalog offers nothing.
 * A tool literally named {@link TOOL_REPLY_CHOICE} is omitted so it cannot collide with text-only.
 */
export function offeredToolChoices(toolNames: readonly string[]): string[] {
	const seen = new Set<string>();
	const offered: string[] = [];
	for (const name of toolNames) {
		if (!name || name === TOOL_REPLY_CHOICE || seen.has(name)) {
			continue;
		}
		seen.add(name);
		offered.push(name);
	}
	if (!offered.length) {
		return [];
	}
	return [TOOL_REPLY_CHOICE, ...offered];
}

/**
 * One Noul for a text answer, plus one Noul per offered tool, in a single request.
 * Reply stays available so a question can be answered without calling a tool.
 * Returns undefined when there is no tool to score.
 */
export function buildToolSurfaceRequest(
	prompt: string,
	mode: string,
	tools: readonly ToolSurfaceTool[],
): PreparedJevCall | undefined {
	const offered = offeredToolChoices(tools.map(tool => tool.name));
	if (!offered.length) {
		return undefined;
	}
	const byName = new Map<string, ToolSurfaceTool>();
	for (const tool of tools) {
		if (tool.name === TOOL_REPLY_CHOICE || byName.has(tool.name)) {
			continue;
		}
		byName.set(tool.name, tool);
	}
	const questions: Record<string, JevQuestion> = {
		[toolSurfaceQuestionId(TOOL_REPLY_CHOICE)]: {
			type: 'noul',
			instructions: 'Should the writer answer in text without calling a tool?',
			criteria: {
				true: 'The user can be answered in text. No tool is needed.',
				false: 'A tool is needed to complete the task',
			},
		},
	};
	const listed: { name: string; description: string }[] = [];
	for (const name of offered) {
		if (name === TOOL_REPLY_CHOICE) {
			continue;
		}
		const tool = byName.get(name);
		if (!tool) {
			continue;
		}
		questions[toolSurfaceQuestionId(name)] = {
			type: 'noul',
			instructions: `Is ${name} required to complete the task?`,
			criteria: {
				true: 'This tool is needed to complete the task',
				false: 'This tool is not needed to complete the task',
			},
		};
		listed.push({
			name,
			description: clip(tool.description, 400),
		});
	}
	return {
		state: {
			task: clip(prompt, 8000),
			mode,
			tools: listed,
		},
		questions,
	};
}

/**
 * Every offered tool whose Noul is at or above the threshold.
 * Reply is not a tool. When its Noul clears the threshold and no tool exceeds it by more than {@link TOOL_SURFACE_REPLY_MARGIN}, the turn is text-only.
 * A missing answer, a non-Noul, or a score under the threshold withholds that tool.
 * An empty list is a text-only turn.
 */
export function interpretToolSurface(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
}): string[] {
	if (args.unavailable || !args.answers) {
		return [];
	}
	if (replyOutranksTools(args.answers, args.offered, args.toolSurfaceConfidence)) {
		return [];
	}
	const selected: string[] = [];
	for (const name of args.offered) {
		if (name === TOOL_REPLY_CHOICE) {
			continue;
		}
		const answer = args.answers[toolSurfaceQuestionId(name)];
		if (answer?.type === 'noul' && answer.noul >= args.toolSurfaceConfidence) {
			selected.push(name);
		}
	}
	return selected;
}

/** Tools the writer may call. An empty list means answer in text. */
export interface ToolSurfaceTrace {
	toolNames: readonly string[];
	/** Reply explanation. The chat prints this only when `integrity.ai.jev.debug` is on. */
	text: string;
	/** State and questions sent to Jev, when a request was built. */
	request?: PreparedJevCall;
}

/**
 * Explain which tools cleared the threshold. The text includes each Noul even when the turn stays text-only.
 * `toolNames` matches {@link interpretToolSurface}.
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
			toolNames: [],
			text: 'Jev tools\ndecision: text only (nothing to choose)',
		};
	}
	const selected = interpretToolSurface(args);
	const lines = ['Jev tools', `offered: ${args.offered.join(', ')}`];
	if (args.answers) {
		for (const name of args.offered) {
			lines.push(`${name}: ${formatToolNoul(args.answers[toolSurfaceQuestionId(name)])}`);
		}
	}
	lines.push(`threshold: ${formatScore(args.toolSurfaceConfidence)}`);
	lines.push(`margin: ${formatScore(TOOL_SURFACE_REPLY_MARGIN)}`);
	lines.push(`decision: ${toolSurfaceDecision(args, selected)}`);
	lines.push(`tools: ${formatNameList(selected)}`);
	const selectedSet = new Set(selected);
	const withheld = args.toolNames.filter(name => name !== TOOL_REPLY_CHOICE && !selectedSet.has(name));
	lines.push(`withheld: ${formatNameList(withheld)}`);
	return { toolNames: selected, text: lines.join('\n') };
}

/** Shown when this turn does not ask Jev which ceiling to use. */
export function describeSkippedToolSurface(reason: string): string {
	return `Jev tools\ndecision: skipped (${reason})`;
}

/**
 * Chat dump of one Jev call: the state and questions that were sent, then the reply.
 * A skipped call has no request, so only the reply is included.
 */
export function formatJevDebug(request: PreparedJevCall | undefined, reply: string): string {
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
 * Human-readable host decision.
 * Reply wins when it clears the threshold and no tool exceeds it by more than the reply margin, so a question can be answered in text.
 * Otherwise every tool at or above the threshold is kept.
 */
function toolSurfaceDecision(args: {
	answers: Record<string, JevAnswer> | undefined;
	unavailable: boolean;
	offered: readonly string[];
	toolSurfaceConfidence: number;
}, selected: readonly string[]): string {
	if (args.unavailable || !args.answers) {
		return 'text only (Jev did not answer)';
	}
	if (replyOutranksTools(args.answers, args.offered, args.toolSurfaceConfidence)) {
		return 'text only (Jev chose reply)';
	}
	if (!selected.length) {
		return `text only (no tool reached ${formatScore(args.toolSurfaceConfidence)})`;
	}
	return `selected ${selected.join(', ')}`;
}

/**
 * True when a text answer clears the threshold and no tool beats it by more than {@link TOOL_SURFACE_REPLY_MARGIN}.
 * A missing reply does not block tools that already passed.
 */
function replyOutranksTools(
	answers: Record<string, JevAnswer>,
	offered: readonly string[],
	toolSurfaceConfidence: number,
): boolean {
	const reply = answers[toolSurfaceQuestionId(TOOL_REPLY_CHOICE)];
	if (reply?.type !== 'noul' || reply.noul < toolSurfaceConfidence) {
		return false;
	}
	let bestTool = Number.NEGATIVE_INFINITY;
	for (const name of offered) {
		if (name === TOOL_REPLY_CHOICE) {
			continue;
		}
		const answer = answers[toolSurfaceQuestionId(name)];
		if (answer?.type === 'noul') {
			bestTool = Math.max(bestTool, answer.noul);
		}
	}
	return reply.noul + TOOL_SURFACE_REPLY_MARGIN >= bestTool;
}

function formatToolNoul(answer: JevAnswer | undefined): string {
	if (!answer) {
		return 'missing';
	}
	if (answer.type !== 'noul') {
		return 'not a noul';
	}
	return formatScore(answer.noul);
}

/**
 * Reject a model tool call that Jev did not keep.
 * A text-only turn rejects every call.
 */
export function rejectionForUnselectedTool(toolName: string, selectedTools: readonly string[]): string | undefined {
	if (!selectedTools.length) {
		return 'Tool error: this turn has no tool. Answer in text.';
	}
	if (!selectedTools.includes(toolName)) {
		return `Tool error: this turn may only call ${selectedTools.join(', ')}.`;
	}
	return undefined;
}

function formatScore(value: number): string {
	return value.toFixed(2);
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

function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, max) + '…';
}
