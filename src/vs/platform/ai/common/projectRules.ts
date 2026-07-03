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
	) {}

	async load(): Promise<string> {
		try {
			const rulesDir = URI.file(this.workspaceRoot + '/.ai-studio/rules');
			const stat = await this.fileService.resolve(rulesDir);
			if (!stat.children || !stat.children.length) return '';

			const mdFiles = stat.children.filter(c => c.name.endsWith('.md'));
			if (!mdFiles.length) return '';

			let block = '\n\n## Project Rules\n';
			for (const f of mdFiles) {
				try {
					const content = (await this.fileService.readFile(URI.file(rulesDir.fsPath + '/' + f.name))).value.toString();
					const name = f.name.replace(/\.md$/i, '');
					block += `\n### ${name}\n${content.trim()}\n`;
				} catch (e) {
					this.logService.warn(`[ProjectRules] Cannot read ${f.name}:`, e);
				}
			}
			return block;
		} catch {
			return '';
		}
	}
}
