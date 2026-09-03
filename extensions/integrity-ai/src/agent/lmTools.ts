/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	applyUniqueReplace,
	isSensitivePath,
	normalizeWorkspaceRelativePath,
} from './pathPolicy';
import { IntegrityToolName } from './toolNames';

export interface CodebaseSearchIndex {
	search(query: string, topK?: number): Promise<Array<{ path: string; content: string; startLine: number; endLine: number }>>;
}

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

function resolveUri(relativePath: string): vscode.Uri | undefined {
	const normalized = normalizeWorkspaceRelativePath(relativePath);
	if (normalized === undefined) {
		return undefined;
	}
	const folder = workspaceFolder();
	if (!folder) {
		return undefined;
	}
	return vscode.Uri.joinPath(folder.uri, normalized);
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

function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

class ReadFileTool implements vscode.LanguageModelTool<{ path: string }> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<{ path: string }>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const relative = normalizeWorkspaceRelativePath(options.input?.path ?? '');
		if (!relative) {
			return textResult('Invalid path: must be workspace-relative without .. traversal.');
		}
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
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const relative = normalizeWorkspaceRelativePath(options.input?.path || '.') ?? '.';
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
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const relative = normalizeWorkspaceRelativePath(options.input?.path ?? '');
		if (!relative) {
			return textResult('Invalid path.');
		}
		const uri = resolveUri(relative);
		if (!uri) {
			return textResult('No workspace open.');
		}

		const overwrite = !!options.input?.overwrite;
		try {
			await vscode.workspace.fs.stat(uri);
			if (!overwrite) {
				return textResult(`File already exists: ${relative}. Pass overwrite=true to replace.`);
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
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const relative = normalizeWorkspaceRelativePath(options.input?.path ?? '');
		if (!relative) {
			return textResult('Invalid path.');
		}
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
		const relative = options.input?.path
			? normalizeWorkspaceRelativePath(options.input.path)
			: undefined;

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
