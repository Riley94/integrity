/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { chunkFile, shouldIgnorePath, shouldIndexFile, type CodeChunk } from './chunker';
import { diffMerkleTrees, hashContent, hashNode, type MerkleNode } from './merkle';
import type { ProviderRouter } from '../providers/router';
import { cosineSimilarity } from '../providers/types';

export interface IndexedChunk extends CodeChunk {
	id: string;
	embedding: number[];
}

export interface SearchResult extends CodeChunk {
	score: number;
}

interface IndexStore {
	version: 1;
	merkleRoot?: MerkleNode;
	chunks: IndexedChunk[];
}

export class CodebaseIndex {
	private store: IndexStore = { version: 1, chunks: [] };
	private indexing = false;
	private watcher?: vscode.FileSystemWatcher;

	constructor(
		private readonly router: ProviderRouter,
	) { }

	async initialize(context: vscode.ExtensionContext): Promise<void> {
		await this.loadStore();
		await this.fullIndex(false);

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			this.watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, '**/*'),
			);
			this.watcher.onDidChange(() => this.scheduleIncremental());
			this.watcher.onDidCreate(() => this.scheduleIncremental());
			this.watcher.onDidDelete(() => this.scheduleIncremental());
			context.subscriptions.push(this.watcher);
		}
	}

	private debounceTimer?: ReturnType<typeof setTimeout>;

	private scheduleIncremental(): void {
		clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			void this.fullIndex(true);
		}, 2000);
	}

	async reindex(): Promise<void> {
		this.store.merkleRoot = undefined;
		this.store.chunks = [];
		await this.fullIndex(false);
	}

	async search(query: string, topK = 8): Promise<SearchResult[]> {
		if (!query.trim() || this.store.chunks.length === 0) {
			return [];
		}

		try {
			const embedder = this.router.getEmbeddingProvider();
			const [queryVec] = await embedder.embed([query]);
			const scored = this.store.chunks.map(chunk => ({
				path: chunk.path,
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language,
				score: cosineSimilarity(queryVec, chunk.embedding),
			}));
			return scored.sort((a, b) => b.score - a.score).slice(0, topK);
		} catch {
			return this.keywordSearch(query, topK);
		}
	}

	private keywordSearch(query: string, topK: number): SearchResult[] {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const scored = this.store.chunks.map(chunk => {
			const text = chunk.content.toLowerCase();
			const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
			return { ...chunk, score };
		});
		return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
	}

	private async fullIndex(incremental: boolean): Promise<void> {
		if (this.indexing) {
			return;
		}
		this.indexing = true;

		try {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return;
			}

			const newRoot = await this.buildMerkleTree(folder.uri);
			const changedPaths = incremental && this.store.merkleRoot
				? new Set(diffMerkleTrees(this.store.merkleRoot, newRoot))
				: undefined;

			this.store.merkleRoot = newRoot;

			if (!changedPaths) {
				this.store.chunks = [];
			} else {
				this.store.chunks = this.store.chunks.filter(c => !changedPaths.has(c.path));
			}

			const filesToIndex = await this.collectFiles(folder.uri);
			const embedder = this.router.getEmbeddingProvider();
			const gitignore = await this.readGitignore(folder.uri);

			for (const fileUri of filesToIndex) {
				const rel = path.relative(folder.uri.fsPath, fileUri.fsPath);
				if (shouldIgnorePath(rel, gitignore)) {
					continue;
				}
				if (changedPaths && !changedPaths.has(rel)) {
					continue;
				}

				try {
					const bytes = await vscode.workspace.fs.readFile(fileUri);
					const content = Buffer.from(bytes).toString('utf8');
					const chunks = chunkFile(rel, content);

					for (const chunk of chunks) {
						const [embedding] = await embedder.embed([chunk.content]);
						this.store.chunks.push({
							...chunk,
							id: `${chunk.path}:${chunk.startLine}`,
							embedding,
						});
					}
				} catch {
					// skip unreadable files
				}
			}

			await this.saveStore();
		} finally {
			this.indexing = false;
		}
	}

	private async buildMerkleTree(root: vscode.Uri, base = ''): Promise<MerkleNode> {
		const entries = await vscode.workspace.fs.readDirectory(root);
		const children: MerkleNode[] = [];

		for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
			const rel = base ? `${base}/${name}` : name;
			if (shouldIgnorePath(rel, [])) {
				continue;
			}
			const uri = vscode.Uri.joinPath(root, name);
			if (type === vscode.FileType.Directory) {
				children.push(await this.buildMerkleTree(uri, rel));
			} else if (shouldIndexFile(name)) {
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					children.push({
						hash: hashContent(Buffer.from(bytes).toString('utf8')),
						path: rel,
						isDirectory: false,
					});
				} catch {
					// skip
				}
			}
		}

		const node: MerkleNode = { hash: '', path: base || '.', isDirectory: true, children };
		node.hash = hashNode(node);
		return node;
	}

	private async collectFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
		const result: vscode.Uri[] = [];
		const walk = async (uri: vscode.Uri) => {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			for (const [name, type] of entries) {
				const child = vscode.Uri.joinPath(uri, name);
				const rel = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, child.fsPath);
				if (shouldIgnorePath(rel, [])) {
					continue;
				}
				if (type === vscode.FileType.Directory) {
					await walk(child);
				} else if (shouldIndexFile(name)) {
					result.push(child);
				}
			}
		};
		await walk(root);
		return result;
	}

	private async readGitignore(root: vscode.Uri): Promise<string[]> {
		try {
			const uri = vscode.Uri.joinPath(root, '.gitignore');
			const bytes = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(bytes).toString('utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
		} catch {
			return ['node_modules', 'dist', 'out', '.git'];
		}
	}

	private indexDir(): vscode.Uri | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}
		return vscode.Uri.joinPath(folder.uri, '.integrity', 'index');
	}

	private async loadStore(): Promise<void> {
		const dir = this.indexDir();
		if (!dir) {
			return;
		}
		try {
			const uri = vscode.Uri.joinPath(dir, 'store.json');
			const bytes = await vscode.workspace.fs.readFile(uri);
			this.store = JSON.parse(Buffer.from(bytes).toString('utf8')) as IndexStore;
		} catch {
			this.store = { version: 1, chunks: [] };
		}
	}

	private async saveStore(): Promise<void> {
		const dir = this.indexDir();
		if (!dir) {
			return;
		}
		try {
			await vscode.workspace.fs.createDirectory(dir);
			const uri = vscode.Uri.joinPath(dir, 'store.json');
			await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.store)));
		} catch {
			// best effort
		}
	}
}
