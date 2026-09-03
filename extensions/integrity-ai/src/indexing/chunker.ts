/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface CodeChunk {
	path: string;
	content: string;
	startLine: number;
	endLine: number;
	language: string;
}

const EXT_LANG: Record<string, string> = {
	'.ts': 'typescript', '.tsx': 'typescript', '': 'javascript', '.jsx': 'javascript',
	'.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
	'.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php',
	'.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala', '.md': 'markdown',
	'.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.sql': 'sql', '.sh': 'shell',
};

const BLOCK_PATTERNS: Record<string, RegExp[]> = {
	typescript: [
		/^(export\s+)?(async\s+)?function\s+\w+[^{]*\{/gm,
		/^(export\s+)?class\s+\w+[^{]*\{/gm,
		/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>\s*\{/gm,
	],
	python: [
		/^def\s+\w+\([^)]*\):/gm,
		/^class\s+\w+[^:]*:/gm,
	],
	rust: [/^pub\s+fn\s+\w+/gm, /^impl\s+/gm, /^struct\s+\w+/gm],
	go: [/^func\s+\([^)]*\)\s+\w+/gm, /^func\s+\w+/gm, /^type\s+\w+/gm],
	default: [/^\s*(function|class|def|func|fn|struct|interface|enum)\s+/gm],
};

export function detectLanguage(filePath: string): string {
	const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
	return EXT_LANG[ext] ?? 'default';
}

export function chunkFile(path: string, content: string, maxChunkSize = 2000): CodeChunk[] {
	const language = detectLanguage(path);
	const lines = content.split('\n');
	const patterns = BLOCK_PATTERNS[language] ?? BLOCK_PATTERNS.default;
	const boundaries = new Set<number>([0]);

	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			const lineNum = content.slice(0, match.index).split('\n').length - 1;
			boundaries.add(lineNum);
		}
	}

	const sorted = [...boundaries].sort((a, b) => a - b);
	const chunks: CodeChunk[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i];
		const end = i + 1 < sorted.length ? sorted[i + 1] - 1 : lines.length - 1;
		const chunkLines = lines.slice(start, end + 1);
		let chunkContent = chunkLines.join('\n').trim();

		if (!chunkContent) {
			continue;
		}

		while (chunkContent.length > maxChunkSize) {
			const splitAt = chunkContent.lastIndexOf('\n', maxChunkSize);
			const piece = chunkContent.slice(0, splitAt > 0 ? splitAt : maxChunkSize);
			chunks.push({
				path,
				content: piece,
				startLine: start + 1,
				endLine: start + piece.split('\n').length,
				language,
			});
			chunkContent = chunkContent.slice(splitAt > 0 ? splitAt + 1 : maxChunkSize);
		}

		if (chunkContent.length > 20) {
			chunks.push({
				path,
				content: chunkContent,
				startLine: start + 1,
				endLine: start + chunkContent.split('\n').length,
				language,
			});
		}
	}

	if (chunks.length === 0 && content.trim().length > 20) {
		chunks.push({
			path,
			content: content.slice(0, maxChunkSize),
			startLine: 1,
			endLine: lines.length,
			language,
		});
	}

	return chunks;
}

export const INDEXABLE_EXTENSIONS = new Set(Object.keys(EXT_LANG));

export function shouldIndexFile(filePath: string): boolean {
	const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
	return INDEXABLE_EXTENSIONS.has(ext);
}

export function shouldIgnorePath(relativePath: string, gitignorePatterns: string[]): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	if (normalized.includes('node_modules/') || normalized.includes('.git/') || normalized.includes('.integrity/')) {
		return true;
	}
	for (const pattern of gitignorePatterns) {
		if (pattern.startsWith('*') && normalized.endsWith(pattern.slice(1))) {
			return true;
		}
		if (normalized.includes(pattern.replace(/\*/g, ''))) {
			return true;
		}
	}
	return false;
}
