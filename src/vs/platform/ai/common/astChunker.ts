/*---------------------------------------------------------------------------------------------
 *  AI Studio — AST-Aware Code Chunker
 *  Structural chunking based on indentation + keyword analysis.
 *  Falls back to regex chunker from chunker.ts for unsupported languages.
 *--------------------------------------------------------------------------------------------*/

import type { ChunkedCode } from './aiTypes.js';

const AST_LANGUAGES = new Set([
	'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
	'python', 'go', 'rust',
]);

function _hash(str: string): string {
	let h = 0;
	for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
	return Math.abs(h).toString(16);
}

export function astChunkFile(filePath: string, content: string, languageId: string): ChunkedCode[] {
	if (!AST_LANGUAGES.has(languageId)) {
		return _regexChunk(filePath, content, languageId);
	}

	const lines = content.split('\n');
	const boundaries = _findStructuralBoundaries(lines, languageId);

	if (!boundaries.length) {
		return [{
			id: _hash(filePath + ':' + content.slice(0, 100)),
			filePath, startLine: 1, endLine: lines.length,
			content, kind: 'module', name: filePath.split('/').pop() || filePath,
		}];
	}

	const chunks: ChunkedCode[] = [];
	for (let i = 0; i < boundaries.length; i++) {
		const start = boundaries[i].line;
		const end = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length;
		const chunkContent = lines.slice(start - 1, end).join('\n');
		if (!chunkContent.trim()) continue;
		chunks.push({
			id: _hash(filePath + ':' + start + ':' + chunkContent.slice(0, 100)),
			filePath, startLine: start, endLine: end,
			content: chunkContent, kind: boundaries[i].kind, name: boundaries[i].name,
		});
	}
	return chunks;
}

interface Boundary {
	line: number;
	kind: ChunkedCode['kind'];
	name: string;
	indent: number;
}

function _findStructuralBoundaries(lines: string[], lang: string): Boundary[] {
	const boundaries: Boundary[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

		const indent = line.length - trimmed.length;
		const b = _matchBoundary(trimmed, lang, i + 1, indent);
		if (b) boundaries.push(b);
	}

	return boundaries.filter(b => b.indent <= 2 || b.kind === 'class' || b.kind === 'function' || b.kind === 'method');
}

function _matchBoundary(line: string, lang: string, lineNum: number, indent: number): Boundary | null {
	switch (lang) {
		case 'typescript':
		case 'javascript':
		case 'typescriptreact':
		case 'javascriptreact': {
			let m: RegExpMatchArray | null;
			if ((m = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/))) return { line: lineNum, kind: 'function', name: m[1], indent };
			if ((m = line.match(/^\s*(?:async\s+)?function\s+(\w+)/))) return { line: lineNum, kind: 'function', name: m[1], indent };
			if ((m = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/))) return { line: lineNum, kind: 'class', name: m[1], indent };
			if ((m = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/))) return { line: lineNum, kind: 'class', name: m[1], indent };
			if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/))) return { line: lineNum, kind: 'function', name: m[1], indent };
			if ((m = line.match(/^\s*(?:public|private|protected|async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/))) return { line: lineNum, kind: 'method', name: m[1], indent };
			return null;
		}
		case 'python': {
			if (line.match(/^\s*def\s+\w+/)) {
				const m = line.match(/^\s*def\s+(\w+)/);
				return m ? { line: lineNum, kind: 'function', name: m[1], indent } : null;
			}
			if (line.match(/^\s*class\s+\w+/)) {
				const m = line.match(/^\s*class\s+(\w+)/);
				return m ? { line: lineNum, kind: 'class', name: m[1], indent } : null;
			}
			return null;
		}
		case 'go': {
			if (line.match(/^\s*func\s+/)) {
				const m = line.match(/^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)/);
				return m ? { line: lineNum, kind: 'function', name: m[1], indent } : null;
			}
			if (line.match(/^\s*type\s+\w+\s+struct/)) {
				const m = line.match(/^\s*type\s+(\w+)\s+struct/);
				return m ? { line: lineNum, kind: 'class', name: m[1], indent } : null;
			}
			return null;
		}
		case 'rust': {
			if (line.match(/^\s*(?:pub(?:\s*\(\s*\w+\s*\))?\s+)?fn\s+\w+/)) {
				const m = line.match(/^\s*(?:pub(?:\s*\(\s*\w+\s*\))?\s+)?fn\s+(\w+)/);
				return m ? { line: lineNum, kind: 'function', name: m[1], indent } : null;
			}
			if (line.match(/^\s*(?:pub\s+)?struct\s+\w+/)) {
				const m = line.match(/^\s*(?:pub\s+)?struct\s+(\w+)/);
				return m ? { line: lineNum, kind: 'class', name: m[1], indent } : null;
			}
			if (line.match(/^\s*(?:pub\s+)?impl\s+/)) {
				const m = line.match(/^\s*(?:pub\s+)?impl\s+(?:\w+\s+for\s+)?(\w+)/);
				return m ? { line: lineNum, kind: 'class', name: 'impl ' + m[1], indent } : null;
			}
			return null;
		}
		default:
			return null;
	}
}

function _regexChunk(filePath: string, content: string, languageId: string): ChunkedCode[] {
	const lines = content.split('\n');
	const boundaries = _getRegexBoundaries(languageId);
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

function _getRegexBoundaries(languageId: string): Array<{ pattern: RegExp; kind: ChunkedCode['kind'] }> {
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
