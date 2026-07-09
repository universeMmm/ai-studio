/*---------------------------------------------------------------------------------------------
 *  AI Studio — Memory Types & YAML frontmatter parser
 *  Reads/writes YAML frontmatter for ~/.ai-studio/memory/*.md files.
 *--------------------------------------------------------------------------------------------*/

import type { MemoryEntry, MemoryType } from './aiTypes.js';

/** Regex to match YAML frontmatter: ---\n...\n--- */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** Parse a memory .md file into a MemoryEntry */
export function parseMemoryFile(raw: string, filename: string): MemoryEntry | null {
	const m = raw.match(FRONTMATTER_RE);
	if (!m) return null;

	const fm = _parseSimpleYaml(m[1]);
	const content = raw.slice(m[0].length).trim();

	const name = fm.name || filename.replace(/\.md$/i, '');
	const description = fm.description || '';
	const type = _validateType(fm.type) ? fm.type as MemoryType : 'reference';

	return { name, description, type, content };
}

/** Serialize a MemoryEntry to .md file content */
export function serializeMemoryFile(entry: MemoryEntry): string {
	const lines = [
		'---',
		`name: ${entry.name}`,
		`description: ${entry.description}`,
		`type: ${entry.type}`,
		'---',
		'',
		entry.content,
	];
	return lines.join('\n');
}

/** Simple YAML key: value parser — handles only flat string values (no nesting) */
function _parseSimpleYaml(yaml: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of yaml.split('\n')) {
		const idx = line.indexOf(':');
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
			result[key] = value;
		}
	}
	return result;
}

function _validateType(t: string): boolean {
	return ['user', 'feedback', 'project', 'reference'].includes(t);
}
