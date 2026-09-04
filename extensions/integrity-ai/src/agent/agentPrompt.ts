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
			return 'You are in Ask mode: answer questions using read-only tools only. Do not edit files or run terminal commands.';
		case 'edit':
			return 'You are in Edit mode: you may read and edit files. Do not run terminal commands.';
		case 'agent':
		default:
			return 'You are in Agent mode: you may read/edit files, search the codebase, manage todos, and run terminal commands when needed. Prefer small, correct edits. Explain briefly when done.';
	}
}

/**
 * Short tool-choice guide for local models (no JSON schemas — those arrive via options.tools).
 */
export const TOOL_DECISION_GUIDE = [
	'Tool choice guide:',
	'- Read / find: integrity_read_file, integrity_list_dir, integrity_file_search, integrity_grep_search, integrity_codebase_search.',
	'- Change files: prefer integrity_apply_patch. To add code: { "path": "main.py", "hunks": [{ "newText": "<code>" }] } or { "path": "main.py", "patch": "<code>" }. For a unique swap use hunks with oldText. Use integrity_replace_string only for an exact in-place swap. Use integrity_create_file only for a brand-new path. Read with integrity_read_file before editing when the file may already exist.',
	'- Paths: always pass a workspace-relative path in "path" (e.g. path: "main.py" or path: "src/main.py"). Never invent placeholders like /path/to/main.py. When the user names a file, use that basename (or integrity_file_search with **/name) — do not ask the user for the path with vscode_askQuestions.',
	'- Shell: run_in_terminal (Agent mode only).',
	'- Browser: open_browser_page / run_playwright_code only when the user asked to open or drive a web page. Never use browser tools to author or edit workspace files.',
].join('\n');

/**
 * Build the Integrity chat participant system prompt.
 */
export function buildSystemPrompt(mode: AgentModeKind, agentRules: string, extraContext: string): string {
	const parts = [
		'You are Integrity AI, a local-first coding assistant built into Integrity IDE.',
		modeSystemPrompt(mode),
		TOOL_DECISION_GUIDE,
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
