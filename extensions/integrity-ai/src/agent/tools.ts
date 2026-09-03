/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { setProposedContent } from './diffProvider';

const execAsync = promisify(exec);

const BLOCKED_COMMANDS = [
	/\brm\s+-rf\s+\//,
	/\bsudo\s+rm/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:(){ :|:& };:/,
];

export interface ToolOptions {
	requireTerminalApproval: boolean;
	requireEditApproval: boolean;
}

export class AgentTools {
	constructor(
		private readonly index: { search(query: string, topK?: number): Promise<Array<{ path: string; content: string; startLine: number; endLine: number }>> },
	) { }

	async execute(tool: string, args: Record<string, string>, opts: ToolOptions): Promise<string> {
		switch (tool) {
			case 'read_file':
				return this.readFile(args.path);
			case 'edit_file':
				return this.editFile(args.path, args.oldText ?? '', args.newText ?? '', opts.requireEditApproval);
			case 'list_dir':
				return this.listDir(args.path ?? '.');
			case 'search':
				return this.search(args.pattern ?? '');
			case 'codebase_search':
				return this.codebaseSearch(args.query ?? '');
			case 'run_terminal':
				return this.runTerminal(args.command ?? '', opts.requireTerminalApproval);
			default:
				return `Unknown tool: ${tool}`;
		}
	}

	private resolvePath(relativePath: string): vscode.Uri | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}
		return vscode.Uri.joinPath(folder.uri, relativePath);
	}

	private async readFile(relativePath: string): Promise<string> {
		if (relativePath.endsWith('.env') || relativePath.includes('.env.')) {
			const confirm = await vscode.window.showWarningMessage(
				`Agent wants to read sensitive file: ${relativePath}`,
				'Allow', 'Deny',
			);
			if (confirm !== 'Allow') {
				return 'Access denied by user.';
			}
		}

		const uri = this.resolvePath(relativePath);
		if (!uri) {
			return 'No workspace open.';
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(bytes).toString('utf8').slice(0, 50000);
		} catch {
			return `File not found: ${relativePath}`;
		}
	}

	private async editFile(relativePath: string, oldText: string, newText: string, requireApproval: boolean): Promise<string> {
		const uri = this.resolvePath(relativePath);
		if (!uri) {
			return 'No workspace open.';
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const content = Buffer.from(bytes).toString('utf8');
			if (oldText && !content.includes(oldText)) {
				return `oldText not found in ${relativePath}`;
			}

			const updated = oldText ? content.replace(oldText, newText) : newText;

			if (requireApproval) {
				const originalUri = uri;
				const modifiedUri = setProposedContent(uri, updated);

				await vscode.commands.executeCommand(
					'vscode.diff',
					originalUri,
					modifiedUri,
					`${relativePath} (original ↔ proposed)`,
				);

				const approved = await vscode.window.showInformationMessage(
					`Apply edit to ${relativePath}?`,
					'Apply', 'Cancel',
				);
				if (approved !== 'Apply') {
					return 'Edit cancelled by user.';
				}
			}

			await vscode.workspace.fs.writeFile(uri, Buffer.from(updated));
			return `Updated ${relativePath}`;
		} catch (err) {
			return `Edit failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	private async listDir(relativePath: string): Promise<string> {
		const uri = this.resolvePath(relativePath);
		if (!uri) {
			return 'No workspace open.';
		}
		try {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			return entries.map(([name, type]) =>
				`${type === vscode.FileType.Directory ? '[dir]' : '[file]'} ${name}`
			).join('\n');
		} catch {
			return `Directory not found: ${relativePath}`;
		}
	}

	private async search(pattern: string): Promise<string> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || !pattern) {
			return 'No workspace or pattern.';
		}
		try {
			const { stdout } = await execAsync(
				`rg --no-heading -n --max-count 20 ${JSON.stringify(pattern)}`,
				{ cwd: folder.uri.fsPath, timeout: 10000 },
			);
			return stdout.slice(0, 10000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('stdout')) {
				return msg;
			}
			return `Search failed (is ripgrep installed?): ${msg}`;
		}
	}

	private async codebaseSearch(query: string): Promise<string> {
		const results = await this.index.search(query, 5);
		if (results.length === 0) {
			return 'No results.';
		}
		return results.map(r =>
			`${r.path}:${r.startLine}-${r.endLine}\n${r.content}`
		).join('\n\n---\n\n');
	}

	private async runTerminal(command: string, requireApproval: boolean): Promise<string> {
		if (!command) {
			return 'Empty command.';
		}

		for (const blocked of BLOCKED_COMMANDS) {
			if (blocked.test(command)) {
				return 'Command blocked for safety.';
			}
		}

		if (requireApproval) {
			const approved = await vscode.window.showWarningMessage(
				`Agent wants to run: ${command}`,
				'Run', 'Deny',
			);
			if (approved !== 'Run') {
				return 'Command denied by user.';
			}
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: folder?.uri.fsPath,
				timeout: 60000,
				maxBuffer: 1024 * 1024,
			});
			return (stdout + stderr).slice(0, 20000) || '(no output)';
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; message?: string };
			return (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? 'Command failed');
		}
	}
}

export async function loadAgentRules(): Promise<string> {
	const folder = vscode.workspace.workspaceFolders?.[0];
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
