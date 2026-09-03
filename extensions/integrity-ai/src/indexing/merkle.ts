/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export interface MerkleNode {
	hash: string;
	path: string;
	isDirectory: boolean;
	children?: MerkleNode[];
}

export function hashContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

export function hashNode(node: MerkleNode): string {
	if (!node.isDirectory) {
		return node.hash;
	}
	const childHashes = (node.children ?? []).map(c => hashNode(c)).sort().join('');
	return createHash('sha256').update(childHashes).digest('hex');
}

export function diffMerkleTrees(oldRoot: MerkleNode | undefined, newRoot: MerkleNode): string[] {
	const changed: string[] = [];
	collectChanges(oldRoot, newRoot, changed);
	return changed;
}

function collectChanges(oldNode: MerkleNode | undefined, newNode: MerkleNode, changed: string[]): void {
	if (!oldNode || hashNode(oldNode) !== hashNode(newNode)) {
		if (!newNode.isDirectory) {
			changed.push(newNode.path);
			return;
		}
		const oldChildren = new Map((oldNode?.children ?? []).map(c => [c.path, c]));
		for (const child of newNode.children ?? []) {
			collectChanges(oldChildren.get(child.path), child, changed);
		}
	}
}

export function simhash(node: MerkleNode): string {
	return hashNode(node).slice(0, 16);
}
