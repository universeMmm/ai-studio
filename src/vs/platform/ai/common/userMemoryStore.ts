/*---------------------------------------------------------------------------------------------
 *  AI Studio — User Memory Store
 *  Reads/writes persistent user memories from ~/.ai-studio/memory/*.md.
 *  Each .md file uses YAML frontmatter (name, description, type) + Markdown body.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { MemoryEntry } from './aiTypes.js';
import { parseMemoryFile, serializeMemoryFile } from './memoryTypes.js';

export const IUserMemoryStore = createDecorator<IUserMemoryStore>('userMemoryStore');

export interface IUserMemoryStore {
	readonly _serviceBrand: undefined;
	list(): Promise<MemoryEntry[]>;
	get(name: string): Promise<MemoryEntry | null>;
	write(entry: MemoryEntry): Promise<void>;
	delete(name: string): Promise<void>;
}

export class UserMemoryStore implements IUserMemoryStore {
	declare readonly _serviceBrand: undefined;

	private readonly _homeDir: string;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		this._homeDir = process.env.HOME || process.env.USERPROFILE || '.';
	}

	private get _memoryDir(): string {
		return this._homeDir + '/.ai-studio/memory';
	}

	async list(): Promise<MemoryEntry[]> {
		try {
			const dirUri = URI.file(this._memoryDir);
			await this.fileService.createFolder(dirUri);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children?.length) return [];

			const entries: MemoryEntry[] = [];
			for (const child of stat.children) {
				if (!child.name.endsWith('.md')) continue;
				try {
					const raw = (await this.fileService.readFile(URI.file(this._memoryDir + '/' + child.name))).value.toString();
					const entry = parseMemoryFile(raw, child.name);
					if (entry) entries.push(entry);
				} catch (e) {
					this.logService.warn(`[UserMemoryStore] Failed to read ${child.name}:`, e);
				}
			}
			return entries;
		} catch {
			return [];
		}
	}

	async get(name: string): Promise<MemoryEntry | null> {
		try {
			const safeName = name.replace(/\.md$/i, '') + '.md';
			const raw = (await this.fileService.readFile(URI.file(this._memoryDir + '/' + safeName))).value.toString();
			return parseMemoryFile(raw, safeName);
		} catch {
			return null;
		}
	}

	async write(entry: MemoryEntry): Promise<void> {
		const safeName = entry.name.replace(/\.md$/i, '') + '.md';
		const content = serializeMemoryFile(entry);
		try { await this.fileService.createFolder(URI.file(this._memoryDir)); } catch { /* exists */ }
		await this.fileService.writeFile(URI.file(this._memoryDir + '/' + safeName), VSBuffer.fromString(content));
		this.logService.info(`[UserMemoryStore] Wrote memory: ${safeName}`);
	}

	async delete(name: string): Promise<void> {
		const safeName = name.replace(/\.md$/i, '') + '.md';
		try {
			await this.fileService.del(URI.file(this._memoryDir + '/' + safeName));
			this.logService.info(`[UserMemoryStore] Deleted memory: ${safeName}`);
		} catch (e) {
			this.logService.warn(`[UserMemoryStore] Failed to delete ${safeName}:`, e);
		}
	}
}
