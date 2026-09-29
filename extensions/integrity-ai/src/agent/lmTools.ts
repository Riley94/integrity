/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	applyPatchHunks,
	applyUniqueReplace,
	extractPathFromInput,
	fileBasename,
	isSensitivePath,
	normalizePatchInput,
	normalizeWorkspaceRelativePath,
	pickUniqueBasenameMatch,
	resolveAgentFilePath,
	type PatchHunk,
} from './pathPolicy';
import { IntegrityToolName } from './toolNames';

export interface CodebaseSearchIndex {
	search(query: string, topK?: number): Promise<Array<{ path: string; content: string; startLine: number; endLine: number }>>;
}

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

function workspaceRootPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

function resolveUri(relativePath: string): vscode.Uri | undefined {
	const normalized = relativePath === '.'
		? '.'
		: normalizeWorkspaceRelativePath(relativePath);
	if (normalized === undefined) {
		return undefined;
	}
	const folder = workspaceFolder();
	if (!folder) {
		return undefined;
	}
	if (normalized === '.' || normalized === '') {
		return folder.uri;
	}
	return vscode.Uri.joinPath(folder.uri, normalized);
}

function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

async function findWorkspacePathsByBasename(basename: string, token?: vscode.CancellationToken): Promise<string[]> {
	const escaped = basename.replace(/[[\]{}*?]/g, '\\$&');
	const uris = await vscode.workspace.findFiles(`**/${escaped}`, '**/node_modules/**', 20, token);
	return uris.map(u => vscode.workspace.asRelativePath(u, false));
}

export type PathFromInputOptions = {
	optional?: boolean;
	defaultPath?: string;
	/**
	 * When the path is a placeholder or outside the workspace, search by basename.
	 * If no matches and this is true, use the basename as a new workspace-relative path
	 * (for create/apply that can create files).
	 */
	createIfMissingBasename?: boolean;
	token?: vscode.CancellationToken;
};

/**
 * Resolve a tool path from input (aliases + absolute-in-workspace + basename search).
 */
async function pathFromInput(
	input: unknown,
	opts?: PathFromInputOptions,
): Promise<{ relative: string } | { error: vscode.LanguageModelToolResult }> {
	const roots = workspaceRootPaths();
	const resolved = resolveAgentFilePath(input, roots, opts);
	if (resolved.ok) {
		return { relative: resolved.path };
	}

	const basename = resolved.basenameLookup ?? fileBasename(extractPathFromInput(input).raw ?? '');
	if (!basename || basename === '.') {
		return { error: textResult(resolved.error) };
	}

	const matches = await findWorkspacePathsByBasename(basename, opts?.token);
	const picked = pickUniqueBasenameMatch(basename, matches);
	if (picked.ok) {
		return { relative: picked.path };
	}

	if (opts?.createIfMissingBasename && matches.length === 0) {
		const normalized = normalizeWorkspaceRelativePath(basename);
		if (normalized) {
			return { relative: normalized };
		}
	}

	return { error: textResult(picked.error) };
}

/**
 * If a resolved relative path is missing on disk and looks like a bare filename,
 * search the workspace by basename and use a unique match.
 */
async function resolveExistingRelativePath(
	relative: string,
	token?: vscode.CancellationToken,
): Promise<{ relative: string } | { error: string }> {
	const uri = resolveUri(relative);
	if (!uri) {
		return { error: 'No workspace open.' };
	}
	try {
		await vscode.workspace.fs.stat(uri);
		return { relative };
	} catch {
		// continue to basename search
	}

	const base = fileBasename(relative);
	if (!base || (relative.includes('/') && base !== relative)) {
		// Path has directories and missed — don't broaden to unrelated basenames unless it's a single segment.
		if (relative.includes('/')) {
			return { error: `File not found: ${relative}` };
		}
	}
	if (!base) {
		return { error: `File not found: ${relative}` };
	}

	const matches = await findWorkspacePathsByBasename(base, token);
	const picked = pickUniqueBasenameMatch(base, matches);
	if (picked.ok) {
		return { relative: picked.path };
	}
	return { error: picked.error };
}

async function confirmSensitiveRead(path: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		`Agent wants to read sensitive file: ${path}`,
		{ modal: true },
		'Allow',
		'Deny',
	);
	return choice === 'Allow';
}

class ReadFileTool implements vscode.LanguageModelTool<{ path: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path: string }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const resolved = await pathFromInput(options.input, { token });
		if ('error' in resolved) {
			return resolved.error;
		}
		const existing = await resolveExistingRelativePath(resolved.relative, token);
		if ('error' in existing) {
			return textResult(existing.error);
		}
		const { relative } = existing;
		if (isSensitivePath(relative) && !(await confirmSensitiveRead(relative))) {
			return textResult('Access denied by user.');
		}
		const uri = resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open.');
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return textResult(Buffer.from(bytes).toString('utf8').slice(0, 50_000));
		} catch {
			return textResult(`File not found: ${relative}`);
		}
	}
}

class ListDirTool implements vscode.LanguageModelTool<{ path?: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path?: string }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const resolved = await pathFromInput(options.input, { optional: true, defaultPath: '.', token });
		if ('error' in resolved) {
			return resolved.error;
		}
		const { relative } = resolved;
		const uri = relative === '.' ? workspaceFolder()?.uri : resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open or invalid path.');
		}
		try {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			const lines = entries
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, type]) => `${type === vscode.FileType.Directory ? '[dir]' : '[file]'} ${name}`);
			return textResult(lines.join('\n') || '(empty)');
		} catch {
			return textResult(`Directory not found: ${relative}`);
		}
	}
}

class CreateFileTool implements vscode.LanguageModelTool<{ path: string; content: string; overwrite?: boolean }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path: string; content: string; overwrite?: boolean }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const resolved = await pathFromInput(options.input, { createIfMissingBasename: true, token });
		if ('error' in resolved) {
			return resolved.error;
		}
		const { relative } = resolved;
		const uri = resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open.');
		}

		const overwrite = !!options.input?.overwrite;
		try {
			await vscode.workspace.fs.stat(uri);
			if (!overwrite) {
				return textResult(
					`File already exists: ${relative}. Use integrity_apply_patch to modify it, or pass overwrite=true to replace.`,
				);
			}
		} catch {
			// does not exist — ok
		}

		const content = options.input?.content ?? '';
		const requireApproval = vscode.workspace.getConfiguration('integrity.ai').get<boolean>('agent.requireEditApproval', true);
		if (requireApproval) {
			const approved = await vscode.window.showInformationMessage(
				`Create/overwrite file ${relative}?`,
				{ modal: true },
				'Apply',
				'Cancel',
			);
			if (approved !== 'Apply') {
				return textResult('Create cancelled by user.');
			}
		}

		const edit = new vscode.WorkspaceEdit();
		edit.createFile(uri, { overwrite, contents: Buffer.from(content) });
		const ok = await vscode.workspace.applyEdit(edit);
		return textResult(ok ? `Created ${relative}` : `Failed to create ${relative}`);
	}
}

class ReplaceStringTool implements vscode.LanguageModelTool<{ path: string; oldText: string; newText: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path: string; oldText: string; newText: string }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const resolved = await pathFromInput(options.input, { token });
		if ('error' in resolved) {
			return resolved.error;
		}
		const existing = await resolveExistingRelativePath(resolved.relative, token);
		if ('error' in existing) {
			return textResult(existing.error);
		}
		const { relative } = existing;
		const uri = resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open.');
		}

		let content: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			content = Buffer.from(bytes).toString('utf8');
		} catch {
			return textResult(`File not found: ${relative}`);
		}

		const result = applyUniqueReplace(content, options.input?.oldText ?? '', options.input?.newText ?? '');
		if (!result.ok) {
			return textResult(result.error);
		}

		const requireApproval = vscode.workspace.getConfiguration('integrity.ai').get<boolean>('agent.requireEditApproval', true);
		if (requireApproval) {
			const doc = await vscode.workspace.openTextDocument(uri);
			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, fullRange, result.updated);

			// Show a quick confirm; edits still go through WorkspaceEdit so they participate in undo.
			const approved = await vscode.window.showInformationMessage(
				`Apply unique replace in ${relative}?`,
				{ modal: true },
				'Apply',
				'Cancel',
			);
			if (approved !== 'Apply') {
				return textResult('Edit cancelled by user.');
			}
			const ok = await vscode.workspace.applyEdit(edit);
			return textResult(ok ? `Updated ${relative}` : `Failed to update ${relative}`);
		}

		const doc = await vscode.workspace.openTextDocument(uri);
		const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, fullRange, result.updated);
		const ok = await vscode.workspace.applyEdit(edit);
		return textResult(ok ? `Updated ${relative}` : `Failed to update ${relative}`);
	}
}

class ApplyPatchTool implements vscode.LanguageModelTool<{ path: string; hunks?: PatchHunk[]; patch?: string; content?: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path: string; hunks?: PatchHunk[]; patch?: string; content?: string }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const resolved = await pathFromInput(options.input, { createIfMissingBasename: true, token });
		if ('error' in resolved) {
			return resolved.error;
		}
		let relative = resolved.relative;
		const uriProbe = resolveUri(relative);
		if (uriProbe) {
			try {
				await vscode.workspace.fs.stat(uriProbe);
			} catch {
				const existing = await resolveExistingRelativePath(relative, token);
				if (!('error' in existing)) {
					relative = existing.relative;
				}
				// else keep basename path for create-via-patch
			}
		}
		const uri = resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open.');
		}

		const normalized = normalizePatchInput(options.input);
		if (!normalized.ok) {
			return textResult(normalized.error);
		}
		const hunks = normalized.hunks;

		let existingContent: string | undefined;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			existingContent = Buffer.from(bytes).toString('utf8');
		} catch {
			existingContent = undefined;
		}

		const result = applyPatchHunks(existingContent, hunks);
		if (!result.ok) {
			return textResult(result.error);
		}

		const requireApproval = vscode.workspace.getConfiguration('integrity.ai').get<boolean>('agent.requireEditApproval', true);
		const actionLabel = result.created ? `Create file ${relative}?` : `Apply patch to ${relative}?`;
		if (requireApproval) {
			const approved = await vscode.window.showInformationMessage(
				actionLabel,
				{ modal: true },
				'Apply',
				'Cancel',
			);
			if (approved !== 'Apply') {
				return textResult('Patch cancelled by user.');
			}
		}

		const edit = new vscode.WorkspaceEdit();
		if (result.created) {
			edit.createFile(uri, { overwrite: false, contents: Buffer.from(result.updated) });
		} else {
			const doc = await vscode.workspace.openTextDocument(uri);
			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			edit.replace(uri, fullRange, result.updated);
		}
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			return textResult(`Failed to apply patch to ${relative}`);
		}
		return textResult(result.created ? `Created ${relative}` : `Updated ${relative}`);
	}
}

class GrepSearchTool implements vscode.LanguageModelTool<{ pattern: string; glob?: string; maxResults?: number }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ pattern: string; glob?: string; maxResults?: number }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const pattern = options.input?.pattern ?? '';
		if (!pattern) {
			return textResult('pattern is required.');
		}
		const folder = workspaceFolder();
		if (!folder) {
			return textResult('No workspace open.');
		}

		const maxResults = Math.min(options.input?.maxResults ?? 40, 100);
		const results: string[] = [];

		await vscode.workspace.findTextInFiles(
			{ pattern, isRegExp: true },
			{
				maxResults,
				include: options.input?.glob
					? new vscode.RelativePattern(folder, options.input.glob)
					: new vscode.RelativePattern(folder, '**/*'),
			},
			result => {
				if (!('preview' in result)) {
					return;
				}
				const match = result as vscode.TextSearchMatch;
				const rel = vscode.workspace.asRelativePath(match.uri);
				const range = Array.isArray(match.ranges) ? match.ranges[0] : match.ranges;
				const line = range?.start.line ?? 0;
				const preview = match.preview?.text?.trim() ?? '';
				results.push(`${rel}:${line + 1}: ${preview}`);
			},
			token,
		);

		return textResult(results.length ? results.join('\n').slice(0, 20_000) : 'No matches.');
	}
}

class FileSearchTool implements vscode.LanguageModelTool<{ glob: string; maxResults?: number }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ glob: string; maxResults?: number }>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const glob = options.input?.glob ?? '';
		if (!glob) {
			return textResult('glob is required.');
		}
		const maxResults = Math.min(options.input?.maxResults ?? 50, 200);
		const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', maxResults, token);
		if (!uris.length) {
			return textResult('No files matched.');
		}
		return textResult(uris.map(u => vscode.workspace.asRelativePath(u)).join('\n'));
	}
}

class CodebaseSearchTool implements vscode.LanguageModelTool<{ query: string }> {
	constructor(private readonly index: CodebaseSearchIndex) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const query = options.input?.query ?? '';
		if (!query.trim()) {
			return textResult('query is required.');
		}
		const hits = await this.index.search(query, 5);
		if (!hits.length) {
			return textResult('No results.');
		}
		return textResult(hits.map(h =>
			`${h.path}:${h.startLine}-${h.endLine}\n${h.content}`
		).join('\n\n---\n\n').slice(0, 30_000));
	}
}

class GetErrorsTool implements vscode.LanguageModelTool<{ path?: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path?: string }>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		let relative: string | undefined;
		const hasPathAlias = options.input && typeof options.input === 'object' && (
			'path' in options.input ||
			'filePath' in options.input ||
			'file_path' in options.input ||
			'filepath' in options.input
		);
		if (hasPathAlias) {
			const resolved = await pathFromInput(options.input, { optional: true });
			if ('error' in resolved) {
				return resolved.error;
			}
			relative = resolved.relative === '.' ? undefined : resolved.relative;
		}

		const diagnostics = vscode.languages.getDiagnostics();
		const lines: string[] = [];
		for (const [uri, diags] of diagnostics) {
			const rel = vscode.workspace.asRelativePath(uri);
			if (relative && rel !== relative && !rel.endsWith('/' + relative) && rel !== relative.replace(/^\.\//, '')) {
				if (!rel.includes(relative) && relative !== rel) {
					continue;
				}
			}
			for (const d of diags) {
				if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {
					continue;
				}
				const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
				lines.push(`${rel}:${d.range.start.line + 1}: [${sev}] ${d.message}`);
				if (lines.length >= 80) {
					break;
				}
			}
			if (lines.length >= 80) {
				break;
			}
		}
		return textResult(lines.length ? lines.join('\n') : 'No errors or warnings.');
	}
}

/**
 * Register Integrity language model tools.
 */
export function registerIntegrityTools(
	context: vscode.ExtensionContext,
	index: CodebaseSearchIndex,
): void {
	context.subscriptions.push(
		vscode.lm.registerTool(IntegrityToolName.ReadFile, new ReadFileTool()),
		vscode.lm.registerTool(IntegrityToolName.ListDir, new ListDirTool()),
		vscode.lm.registerTool(IntegrityToolName.CreateFile, new CreateFileTool()),
		vscode.lm.registerTool(IntegrityToolName.ReplaceString, new ReplaceStringTool()),
		vscode.lm.registerTool(IntegrityToolName.ApplyPatch, new ApplyPatchTool()),
		vscode.lm.registerTool(IntegrityToolName.GrepSearch, new GrepSearchTool()),
		vscode.lm.registerTool(IntegrityToolName.FileSearch, new FileSearchTool()),
		vscode.lm.registerTool(IntegrityToolName.CodebaseSearch, new CodebaseSearchTool(index)),
		vscode.lm.registerTool(IntegrityToolName.GetErrors, new GetErrorsTool()),
	);
}

/**
 * Load project agent rules from `.integrity/agent-rules.md`.
 */
export async function loadAgentRules(): Promise<string> {
	const folder = workspaceFolder();
	if (!folder) {
		return '';
	}
	const uri = vscode.Uri.joinPath(folder.uri, '.integrity', 'agent-rules.md');
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8');
	} catch {
		return '';
	}
}
