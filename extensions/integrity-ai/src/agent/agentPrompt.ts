/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { AgentModeKind } from './toolNames';

/**
 * Mode-specific system prompt sentence.
 */
export function modeSystemPrompt(mode: AgentModeKind): string {
	switch (mode) {
		case 'ask':
			return 'You are in Ask mode.';
		case 'edit':
			return 'You are in Edit mode. Prefer small, correct edits.';
		case 'agent':
		default:
			return 'You are in Agent mode. Prefer small, correct edits. Explain briefly when done.';
	}
}

export interface SelectedToolPrompt {
	name: string;
	description: string;
}

/**
 * Instructions for the tools Jev kept, or text-only when Jev kept none.
 * Does not name any other tool.
 */
export function toolTurnInstructions(tools: readonly SelectedToolPrompt[]): string {
	if (!tools.length) {
		return 'This turn has no tools. Answer in text. Do not call tools.';
	}
	if (tools.length === 1) {
		const tool = tools[0];
		const description = tool.description.trim();
		const detail = description ? ` ${description}` : '';
		return `Tool for this turn: ${tool.name}.${detail} Call only ${tool.name}. Do not call any other tool.`;
	}
	const listed = tools.map(tool => {
		const description = tool.description.trim();
		return description ? `${tool.name}. ${description}` : tool.name;
	}).join(' ');
	const names = tools.map(tool => tool.name).join(', ');
	return `Tools for this turn: ${listed} Call only ${names}. Do not call any other tool.`;
}

/**
 * Build the Integrity chat participant system prompt.
 * `tools` are the only tools the writer may see. Omit them for a text-only turn.
 */
export function buildSystemPrompt(
	mode: AgentModeKind,
	agentRules: string,
	extraContext: string,
	tools: readonly SelectedToolPrompt[] = [],
): string {
	const parts = [
		'You are Integrity AI, a local-first coding assistant built into Integrity IDE.',
		modeSystemPrompt(mode),
		toolTurnInstructions(tools),
		'Be concise. Use markdown code fences with language tags when showing code.',
	];
	if (agentRules.trim()) {
		parts.push('\n--- Project agent rules ---\n' + agentRules.trim());
	}
	if (extraContext.trim()) {
		parts.push('\n--- Context ---\n' + extraContext.trim());
	}
	return parts.join('\n');
}
