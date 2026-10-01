/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { SCRATCHPAD_REQUIRED_PROMPT } from './scratchpadHostRule';
import type { SessionFileRecord } from './sessionFiles';
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
			return 'You are in Agent mode. Prefer small, correct edits. Explain briefly when done. A control, command, or screen should perform the behavior the user asked for. Leave it non-functional only when they explicitly ask for a placeholder.';
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
 * `requireScratchpad` adds the host-rule sentence when the scratchpad is already in `tools`.
 * `sessionFiles` are paths written earlier in this chat. Empty for the first turn.
 * `readSessionFilesBeforeEdit` adds the read-before-edit line. Set it only when the read tool
 * is already in `tools`, so a text-only turn is not told to call a tool it does not have.
 */
export function buildSystemPrompt(
	mode: AgentModeKind,
	agentRules: string,
	extraContext: string,
	tools: readonly SelectedToolPrompt[] = [],
	requireScratchpad = false,
	sessionFiles: readonly SessionFileRecord[] = [],
	readSessionFilesBeforeEdit = false,
): string {
	const parts = [
		'You are Integrity AI, a local-first coding assistant built into Integrity IDE.',
		modeSystemPrompt(mode),
		toolTurnInstructions(tools),
		'Be concise. Use markdown code fences with language tags when showing code.',
	];
	if (requireScratchpad) {
		parts.push(SCRATCHPAD_REQUIRED_PROMPT);
	}
	if (sessionFiles.length) {
		const listed = sessionFiles.map(file => `- ${file.path} (${file.action})`).join('\n');
		const lines = [
			'\n--- Files already changed in this chat ---',
			listed,
			'Keep going in these files and in this language. Do not start a new file or a new language unless the user asks.',
		];
		if (readSessionFilesBeforeEdit) {
			lines.push('Read these files with integrity_read_file before editing them.');
		}
		parts.push(lines.join('\n'));
	}
	if (agentRules.trim()) {
		parts.push('\n--- Project agent rules ---\n' + agentRules.trim());
	}
	if (extraContext.trim()) {
		parts.push('\n--- Context ---\n' + extraContext.trim());
	}
	return parts.join('\n');
}
