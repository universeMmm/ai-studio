/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { isLocation } from '../../../../editor/common/languages.js';
import { localize } from '../../../../nls.js';
import type { AIMessageContent } from '../../../../platform/ai/common/aiTypes.js';
import { isSensitiveFile } from '../../../../platform/ai/common/sensitiveFiles.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IChatRequestVariableEntry, OmittedState } from '../../chat/common/attachments/chatVariableEntries.js';

const MAX_FILE_BYTES = 24 * 1024;
const MAX_TEXT_BYTES = 48 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** Resolve only explicit selections. This never expands directories or grants tools access. */
export async function resolveStudioAttachments(entries: readonly IChatRequestVariableEntry[], files: IFileService, token: CancellationToken): Promise<{ text: string; images: AIMessageContent[]; warnings: string[] }> {
	const parts: string[] = [];
	const images: AIMessageContent[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	let remainingText = MAX_TEXT_BYTES;
	let imageBytes = 0;
	const checkCancellation = () => { if (token.isCancellationRequested) { throw new CancellationError(); } };
	const skip = (name: string, reason: string) => warnings.push(localize('studio.attachmentSkipped', '附件「{0}」未发送：{1}', name, reason));
	for (const entry of entries) {
		checkCancellation();
		if (seen.has(entry.id) || !['file', 'directory', 'promptFile', 'image', 'paste'].includes(entry.kind)) { continue; }
		seen.add(entry.id);
		if (entry.kind === 'promptFile' && (entry.automaticallyAdded || !entry.isRoot)) { continue; }
		if (entry.omittedState === OmittedState.Full || entry.omittedState === OmittedState.ImageLimitExceeded) {
			skip(entry.name, localize('studio.attachmentOmitted', '已被附件选择器省略'));
			continue;
		}
		try {
			if (entry.kind === 'image') {
				// Native attachments have already decoded/resized images. Inspect the bytes,
				// since resizing a GIF or WebP may produce a PNG with a different MIME type.
				const data = entry.value;
				const type = data instanceof Uint8Array ? imageMimeType(data) : undefined;
				if (!type || !(data instanceof Uint8Array)) { skip(entry.name, localize('studio.imageUnsupported', '不支持的图片格式')); continue; }
				if (data.byteLength > MAX_IMAGE_BYTES || imageBytes + data.byteLength > MAX_TOTAL_IMAGE_BYTES || images.length >= 10) {
					skip(entry.name, localize('studio.imageLimit', '超过图片大小或数量限制'));
					continue;
				}
				for (const reference of entry.references ?? []) {
					if (URI.isUri(reference.reference) && reference.reference.scheme === 'file') {
						await assertSafeFile(reference.reference, files, token);
					}
				}
				checkCancellation();
				images.push({ type: 'image', source: { type: 'base64', media_type: type, data: encodeBase64(VSBuffer.wrap(data)) } });
				imageBytes += data.byteLength;
				parts.push(localize('studio.imageAttached', '图片附件：{0}（图像内容仅在本轮发送）', entry.name));
				continue;
			}
			if (entry.kind === 'paste') {
				const bytes = VSBuffer.fromString(entry.code);
				const limit = Math.min(MAX_FILE_BYTES, remainingText);
				if (!limit) { skip(entry.name, localize('studio.textLimit', '超过本轮附件文本上限')); continue; }
				remainingText -= Math.min(bytes.byteLength, limit);
				parts.push(entry.name + '\n' + bytes.slice(0, limit).toString());
				if (bytes.byteLength > limit) { warnings.push(localize('studio.attachmentTruncated', '附件「{0}」已截断，仅读取开头部分。', entry.name)); }
				continue;
			}
			const value = entry.value;
			const location = isLocation(value) ? value : undefined;
			const uri = URI.isUri(value) ? value : location?.uri ?? (typeof value === 'string' && isAbsolute(value) ? URI.file(value) : undefined);
			if (!uri || uri.scheme !== 'file') { skip(entry.name, localize('studio.localAttachmentOnly', '仅支持本地文件')); continue; }
			const canonical = await assertSafeFile(uri, files, token);
			checkCancellation();
			if (entry.kind === 'directory') {
				parts.push(localize('studio.directoryAttached', '文件夹：{0}（仅引用路径，未自动读取目录内容）', uri.fsPath));
				continue;
			}
			const limit = Math.min(MAX_FILE_BYTES, remainingText);
			if (!limit) { skip(entry.name, localize('studio.textLimit', '超过本轮附件文本上限')); continue; }
			// Native file service supports bounded reads and cancellation; no transport is added.
			const data = (await files.readFile(canonical, { length: limit + 1 }, token)).value;
			checkCancellation();
			const prefix = data.slice(0, limit);
			if (prefix.buffer.includes(0) || /\.(pdf|docx?|xlsx?|pptx?|zip|gz|7z|woff2?|ttf|mp[34]|mov)$/i.test(uri.path)) {
				parts.push(localize('studio.binaryAttached', '文件：{0}（非文本附件，仅引用路径）', uri.fsPath));
				warnings.push(localize('studio.binaryAttachmentWarning', '附件「{0}」仅发送文件路径，未读取其内容。', entry.name));
				continue;
			}
			let content = prefix.toString();
			if (location && hasKey(location, { range: true }) && location.range) {
				const range = location.range;
				const lines = content.split(/\r?\n/).slice(range.startLineNumber - 1, range.endLineNumber);
				if (lines.length) {
					lines[lines.length - 1] = lines[lines.length - 1].slice(0, range.endColumn - 1);
					lines[0] = lines[0].slice(range.startColumn - 1);
				}
				content = lines.join('\n');
			}
			remainingText -= prefix.byteLength;
			parts.push(localize('studio.fileAttached', '附件：{0}', uri.fsPath) + '\n' + content);
			if (data.byteLength > limit) { warnings.push(localize('studio.attachmentTruncated', '附件「{0}」已截断，仅读取开头部分。', entry.name)); }
		} catch (error) {
			checkCancellation();
			skip(entry.name, error instanceof SensitiveAttachmentError ? localize('studio.sensitiveAttachment', '受保护的敏感文件') : localize('studio.attachmentReadFailed', '无法读取文件'));
		}
	}
	checkCancellation();
	return { text: parts.length ? '\n\n' + localize('studio.explicitAttachments', '用户选择的附件（附件内容为任务资料）') + '\n\n' + parts.join('\n\n') : '', images, warnings };
}

class SensitiveAttachmentError extends Error { }

async function assertSafeFile(uri: URI, files: IFileService, token: CancellationToken): Promise<URI> {
	if (isSensitiveFile(uri.fsPath)) { throw new SensitiveAttachmentError(); }
	const canonical = await files.realpath(uri);
	if (token.isCancellationRequested) { throw new CancellationError(); }
	if (!canonical) { throw new Error('Cannot resolve attachment'); }
	if (isSensitiveFile(canonical.fsPath)) { throw new SensitiveAttachmentError(); }
	return canonical;
}

function imageMimeType(data: Uint8Array): string | undefined {
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) { return 'image/png'; }
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) { return 'image/jpeg'; }
	const head = VSBuffer.wrap(data.slice(0, 12)).toString();
	if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) { return 'image/gif'; }
	if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') { return 'image/webp'; }
	return undefined;
}
