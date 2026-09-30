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
 * Instructions for the single tool Jev selected, or text-only when Jev selected none.
 * Does not name any other tool.
 */
export function toolTurnInstructions(tool: SelectedToolPrompt | undefined): string {
	if (!tool) {
		return 'This turn has no tools. Answer in text. Do not call tools.';
	}
	const description = tool.description.trim();
	const detail = description ? ` ${description}` : '';
	return `Tool for this turn: ${tool.name}.${detail} Call only ${tool.name}. Do not call any other tool.`;
}

/**
 * Build the Integrity chat participant system prompt.
 * `tool` is the only tool the writer may see. Omit it for a text-only turn.
 */
export function buildSystemPrompt(
	mode: AgentModeKind,
	agentRules: string,
	extraContext: string,
	tool?: SelectedToolPrompt,
): string {
	const parts = [
		'You are Integrity AI, a local-first coding assistant built into Integrity IDE.',
		modeSystemPrompt(mode),
		toolTurnInstructions(tool),
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
