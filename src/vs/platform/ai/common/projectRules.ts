/*---------------------------------------------------------------------------------------------
 *  AI Studio — Project Rules
 *  Reads .ai-studio/rules/*.md files and assembles them into a system prompt block.
 *  Mirrors Cursor''s .cursor/rules/ and Claude Code''s CLAUDE.md pattern.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';

export class ProjectRules {
	constructor(
		private readonly workspaceRoot: string,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		private readonly homeDir: string = '',
	) {}

	async load(): Promise<string> {
		const root = this.workspaceRoot === '.' ? '' : this.workspaceRoot;
		const seenPaths = new Set<string>();
		const sections: { label: string; uri: URI }[] = [];

		// Priority 1: AISTUDIO.md in workspace root
		if (root) {
			sections.push({
				label: 'AISTUDIO.md (AISTUDIO.md)',
				uri: URI.file(root + '/AISTUDIO.md'),
			});
		}

		// Priority 2: CLAUDE.md in workspace root
		if (root) {
			sections.push({
				label: 'CLAUDE.md (CLAUDE.md)',
				uri: URI.file(root + '/CLAUDE.md'),
			});
		}

		// Priority 3: Walk up parent directories for CLAUDE.md
		if (root) {
			let current = this._parentPath(root);
			while (current) {
				const parentClaudeUri = URI.file(current + '/CLAUDE.md');
				const relPath = this._relativePath(root, current + '/CLAUDE.md');
				sections.push({
					label: `CLAUDE.md (${relPath})`,
					uri: parentClaudeUri,
				});
				const parent = this._parentPath(current);
				if (parent === current) { break; }
				current = parent;
			}
		}

		// Priority 4: ~/.ai-studio/CLAUDE.md
		if (this.homeDir) {
			sections.push({
				label: 'CLAUDE.md (~/.ai-studio/CLAUDE.md)',
				uri: URI.file(this.homeDir + '/.ai-studio/CLAUDE.md'),
			});
		}

		let block = '';

		// Read all discovered files
		for (const { label, uri } of sections) {
			if (seenPaths.has(uri.fsPath)) { continue; }
			seenPaths.add(uri.fsPath);
			try {
				const content = (await this.fileService.readFile(uri)).value.toString().trim();
				if (content) {
					if (!block) { block = '\n\n## Project Rules\n'; }
					block += `\n### ${label}\n${content}\n`;
				}
			} catch {
				// File doesn't exist or can't be read — skip
			}
		}

		// Priority 5: .ai-studio/rules/*.md (existing behavior)
		if (root) {
			try {
				const rulesDir = URI.file(root + '/.ai-studio/rules');
				const stat = await this.fileService.resolve(rulesDir);
				if (stat.children?.length) {
					const mdFiles = stat.children.filter(c => c.name.endsWith('.md'));
					for (const f of mdFiles) {
						const rulesUri = URI.file(rulesDir.fsPath + '/' + f.name);
						if (seenPaths.has(rulesUri.fsPath)) { continue; }
						seenPaths.add(rulesUri.fsPath);
						try {
							const content = (await this.fileService.readFile(rulesUri)).value.toString().trim();
							if (content) {
								const name = f.name.replace(/\.md$/i, '');
								if (!block) { block = '\n\n## Project Rules\n'; }
								block += `\n### ${name}\n${content}\n`;
							}
						} catch (e) {
							this.logService.warn(`[ProjectRules] Cannot read ${f.name}:`, e);
						}
					}
				}
			} catch {
				// rules directory doesn't exist
			}
		}

		return block;
	}

	/** Walk up one level in the filesystem tree */
	private _parentPath(p: string): string {
		const normalized = p.replace(/\\/g, '/');
		const idx = normalized.lastIndexOf('/');
		if (idx <= 0) { return normalized === '/' ? '/' : ''; }
		const parent = normalized.substring(0, idx);
		// On Windows, check for drive root like "C:"
		if (parent.endsWith(':')) { return parent + '/'; }
		return parent || '/';
	}

	/** Compute a relative path from `from` to `to` using `../` notation */
	private _relativePath(from: string, to: string): string {
		const fromParts = from.replace(/\\/g, '/').split('/').filter(Boolean);
		const toParts = to.replace(/\\/g, '/').split('/').filter(Boolean);
		let commonIdx = 0;
		while (commonIdx < fromParts.length && commonIdx < toParts.length && fromParts[commonIdx] === toParts[commonIdx]) {
			commonIdx++;
		}
		const upCount = fromParts.length - commonIdx;
		const relParts = Array(upCount).fill('..').concat(toParts.slice(commonIdx));
		return relParts.join('/');
	}
}
