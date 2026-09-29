/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Detects browser/Playwright tool calls that look like workspace file edits
 * so the Integrity agent can reject them before invoking workbench tools.
 */

const FILE_EDIT_REJECTION =
	'Tool error: browser tools do not create or edit workspace files. ' +
	'Use integrity_read_file then integrity_apply_patch (or integrity_replace_string / integrity_create_file) instead.';

const PATH_FISHING_REJECTION =
	'Tool error: do not ask the user for a file path. ' +
	'Use integrity_file_search (e.g. glob "**/main.py") or pass a workspace-relative path like "main.py", ' +
	'then integrity_read_file / integrity_apply_patch / integrity_create_file. Never invent placeholders like /path/to/file.';

const PAGE_REF = /\bpage\s*\.|await\s+page\b|\bpage\s*\)/;

const WORKSPACE_SOURCE = /\bdef\s+\w+\s*\(|\bprint\s*\(|\binput\s*\(|\bif\s+__name__\b|^\s*import\s+\w+|^\s*from\s+\w+\s+import\b|#!\/usr/m;

const SOURCE_FILE_PATH = /\.(py|ts|tsx|js|jsx|mjs|cjs|java|go|rs|rb|php|cs|cpp|c|h|hpp|md|txt|json|yml|yaml|toml|sh)$/i;

const BROWSER_URL_SCHEME = /^(https?|file|about):/i;

const PATH_FISHING_QUESTION = /file\s*path|workspace[- ]relative\s*path|correct\s*(file\s*)?path|path\s*to\s*(the\s*)?file|provide\s+(the\s+)?(correct\s+)?(file\s*)?path|which\s+file/i;

function asRecord(input: unknown): Record<string, unknown> {
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		return input as Record<string, unknown>;
	}
	return {};
}

function looksLikeWorkspacePath(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	if (BROWSER_URL_SCHEME.test(trimmed)) {
		return false;
	}
	// Bare path or relative path ending in a source extension.
	if (SOURCE_FILE_PATH.test(trimmed)) {
		return true;
	}
	// No scheme and looks like a relative workspace path (no host).
	if (!trimmed.includes('://') && /^[\w./\\-]+$/.test(trimmed) && /[./\\]/.test(trimmed)) {
		return true;
	}
	return false;
}

function looksLikePageIdAsFilePath(pageId: string): boolean {
	return SOURCE_FILE_PATH.test(pageId.trim());
}

/**
 * If this tool call should be blocked as a misrouted file edit, return the
 * rejection message. Otherwise return undefined (allow the call).
 */
export function rejectionForBrowserToolCall(toolName: string, input: unknown): string | undefined {
	const args = asRecord(input);

	if (toolName === 'run_playwright_code') {
		const code = typeof args.code === 'string' ? args.code : '';
		const pageId = typeof args.pageId === 'string' ? args.pageId : '';

		// Deferred waits or empty code with a real page id are not file edits.
		if (!code.trim()) {
			return undefined;
		}

		// Conservative: if the snippet drives Playwright's page object, allow it.
		if (PAGE_REF.test(code)) {
			return undefined;
		}

		const fileShaped =
			WORKSPACE_SOURCE.test(code) ||
			looksLikePageIdAsFilePath(pageId);

		if (fileShaped) {
			return FILE_EDIT_REJECTION;
		}
		return undefined;
	}

	if (toolName === 'open_browser_page') {
		const url = typeof args.url === 'string' ? args.url : '';
		if (url && looksLikeWorkspacePath(url)) {
			return FILE_EDIT_REJECTION;
		}
		return undefined;
	}

	return undefined;
}

/**
 * Reject vscode_askQuestions that only fish for a file path the agent should resolve itself.
 */
export function rejectionForPathFishingAskQuestions(toolName: string, input: unknown): string | undefined {
	if (toolName !== 'vscode_askQuestions') {
		return undefined;
	}
	const args = asRecord(input);
	const questions = args.questions;
	if (!Array.isArray(questions) || !questions.length) {
		return undefined;
	}

	const texts: string[] = [];
	for (const q of questions) {
		if (!q || typeof q !== 'object') {
			continue;
		}
		const rec = q as Record<string, unknown>;
		if (typeof rec.question === 'string') {
			texts.push(rec.question);
		}
		if (typeof rec.header === 'string') {
			texts.push(rec.header);
		}
	}
	const blob = texts.join('\n');
	if (PATH_FISHING_QUESTION.test(blob)) {
		return PATH_FISHING_REJECTION;
	}
	return undefined;
}

/**
 * Combined pre-invoke guard for Integrity agent tool calls.
 */
export function rejectionForMisroutedToolCall(toolName: string, input: unknown): string | undefined {
	return rejectionForBrowserToolCall(toolName, input)
		?? rejectionForPathFishingAskQuestions(toolName, input);
}
