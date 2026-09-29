/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool name constants contributed by Integrity AI.
 */
export const IntegrityToolName = {
	ReadFile: 'integrity_read_file',
	ListDir: 'integrity_list_dir',
	CreateFile: 'integrity_create_file',
	ReplaceString: 'integrity_replace_string',
	ApplyPatch: 'integrity_apply_patch',
	GrepSearch: 'integrity_grep_search',
	FileSearch: 'integrity_file_search',
	CodebaseSearch: 'integrity_codebase_search',
	GetErrors: 'integrity_get_errors',
} as const;

export type IntegrityToolName = (typeof IntegrityToolName)[keyof typeof IntegrityToolName];

/** Tools allowed in Ask (read-only) mode. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	IntegrityToolName.ReadFile,
	IntegrityToolName.ListDir,
	IntegrityToolName.GrepSearch,
	IntegrityToolName.FileSearch,
	IntegrityToolName.CodebaseSearch,
	IntegrityToolName.GetErrors,
]);

/** Mutating file tools (Edit + Agent). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
	IntegrityToolName.CreateFile,
	IntegrityToolName.ReplaceString,
	IntegrityToolName.ApplyPatch,
]);

/**
 * Workbench / shared tools we prefer to leave enabled in Agent mode.
 */
export const AGENT_EXTRA_TOOL_HINTS = [
	'run_in_terminal',
	'get_terminal_output',
	'manage_todo_list',
	'vscode_reviewPlan',
	'vscode_askQuestions',
] as const;

export type AgentModeKind = 'ask' | 'edit' | 'agent';

/**
 * Infer ask/edit/agent from mode instructions name.
 */
export function inferModeKind(modeName: string | undefined): AgentModeKind {
	const name = (modeName ?? 'agent').toLowerCase();
	if (name === 'ask' || name.includes('ask')) {
		return 'ask';
	}
	if (name === 'edit' || name.includes('edit')) {
		return 'edit';
	}
	return 'agent';
}

/**
 * Whether a contributed/workbench tool should be offered for the given mode.
 */
export function isToolAllowedInMode(toolName: string, mode: AgentModeKind): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) {
		return true;
	}
	if (EDIT_TOOLS.has(toolName)) {
		return mode === 'edit' || mode === 'agent';
	}
	// Unknown / workbench tools: only in agent (and edit gets none of the extras).
	if (mode === 'ask') {
		return false;
	}
	if (mode === 'edit') {
		// Edit: allow only our edit tools + read-only (already handled). Block terminal.
		return !/terminal/i.test(toolName) && !/run_in_terminal/i.test(toolName);
	}
	return true;
}
