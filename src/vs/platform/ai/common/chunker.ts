/*---------------------------------------------------------------------------------------------
 *  AI Studio — Code Chunker
 *  Splits source files into function/class/method-level chunks for embedding.
 *--------------------------------------------------------------------------------------------*/

import type { ChunkedCode } from './aiTypes.js';

function _hash(str: string): string {
	let h = 0;
	for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
	return Math.abs(h).toString(16);
}

export function chunkFile(filePath: string, content: string, languageId: string): ChunkedCode[] {
	const lines = content.split('\n');
	const boundaries = _getBoundaries(languageId);
	const found: Array<{ line: number; kind: ChunkedCode['kind']; name: string }> = [];
	if (boundaries.length) {
		for (let i = 0; i < lines.length; i++) {
			for (const { pattern, kind } of boundaries) {
				const m = lines[i].match(pattern);
				if (m) { found.push({ line: i + 1, kind, name: m[1] || m[2] || '' }); break; }
			}
		}
	}
	if (!found.length) {
		return [{ id: _hash(filePath + ':' + content.slice(0, 100)), filePath, startLine: 1, endLine: lines.length, content, kind: 'module', name: filePath.split('/').pop() || filePath }];
	}
	const chunks: ChunkedCode[] = [];
	for (let i = 0; i < found.length; i++) {
		const start = found[i].line;
		const end = i + 1 < found.length ? found[i + 1].line - 1 : lines.length;
		const chunkContent = lines.slice(start - 1, end).join('\n');
		if (!chunkContent.trim()) continue;
		chunks.push({ id: _hash(filePath + ':' + start + ':' + chunkContent.slice(0, 100)), filePath, startLine: start, endLine: end, content: chunkContent, kind: found[i].kind, name: found[i].name });
	}
	return chunks;
}

function _getBoundaries(languageId: string): Array<{ pattern: RegExp; kind: ChunkedCode['kind'] }> {
	switch (languageId) {
		case 'typescript': case 'javascript': case 'typescriptreact': case 'javascriptreact':
			return [
				{ pattern: /^\s*export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' },
				{ pattern: /^\s*(?:async\s+)?function\s+(\w+)/, kind: 'function' },
				{ pattern: /^\s*(?:export\s+)?class\s+(\w+)/, kind: 'class' },
				{ pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, kind: 'function' },
			];
		case 'python': return [{ pattern: /^\s*def\s+(\w+)/, kind: 'function' }, { pattern: /^\s*class\s+(\w+)/, kind: 'class' }];
		case 'go': return [{ pattern: /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)/, kind: 'function' }, { pattern: /^\s*type\s+(\w+)\s+struct/, kind: 'class' }];
		case 'rust': return [{ pattern: /^\s*(?:pub\s+)?fn\s+(\w+)/, kind: 'function' }, { pattern: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'class' }];
		case 'java': return [{ pattern: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/, kind: 'method' }, { pattern: /^\s*(?:public\s+)?class\s+(\w+)/, kind: 'class' }];
		default: return [];
	}
}
