/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
}

export class ChatHistory {
	private messages: ChatMessage[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.load();
	}

	private load(): void {
		const stored = this.context.workspaceState.get<ChatMessage[]>('integrity.chatHistory');
		if (stored) {
			this.messages = stored;
		}
	}

	private async persist(): Promise<void> {
		await this.context.workspaceState.update('integrity.chatHistory', this.messages);
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const uri = vscode.Uri.joinPath(folder.uri, '.integrity', 'chat-history.json');
			try {
				await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.integrity'));
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.messages, null, 2)));
			} catch {
				// best effort
			}
		}
	}

	getAll(): ChatMessage[] {
		return [...this.messages];
	}

	async add(role: ChatMessage['role'], content: string): Promise<ChatMessage> {
		const msg: ChatMessage = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			role,
			content,
			timestamp: Date.now(),
		};
		this.messages.push(msg);
		await this.persist();
		return msg;
	}

	async update(id: string, content: string): Promise<void> {
		const msg = this.messages.find(m => m.id === id);
		if (msg) {
			msg.content = content;
			await this.persist();
		}
	}

	async clear(): Promise<void> {
		this.messages = [];
		await this.persist();
	}
}
