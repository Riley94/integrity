/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const proposedContent = new Map<string, string>();

export function registerAgentDiffProvider(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider('integrity-agent', {
			provideTextDocumentContent: (uri: vscode.Uri) => {
				return proposedContent.get(uri.toString()) ?? '';
			},
		}),
	);
}

export function setProposedContent(uri: vscode.Uri, content: string): vscode.Uri {
	const proposedUri = uri.with({ scheme: 'integrity-agent', path: uri.path + '.proposed' });
	proposedContent.set(proposedUri.toString(), content);
	return proposedUri;
}

export function clearProposedContent(uri: vscode.Uri): void {
	proposedContent.delete(uri.toString());
}
