/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Limiter, raceCancellation, raceTimeout } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { LRUCache } from '../../../base/common/map.js';
import { Schemas } from '../../../base/common/network.js';
import { extname, isAbsolute } from '../../../base/common/path.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IFileThumbnailOptions } from '../common/native.js';

interface IThumbnailImage {
	isEmpty(): boolean;
	getSize(scaleFactor?: number): { width: number; height: number };
	resize(options: { width: number; height: number; quality: 'good' }): IThumbnailImage;
	toPNG(options: { scaleFactor: number }): Uint8Array;
}

type ThumbnailFactory = (filePath: string, size: { width: number; height: number }) => Promise<IThumbnailImage>;
const previewExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.ods', '.odp', '.rtf', '.pages', '.numbers', '.key', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const maxFileBytes = 50 * 1024 * 1024;
const maxPreviewBytes = 512 * 1024;
const maxPendingRequests = 32;

/** Bounded, memory-only adapter around the operating system's thumbnail provider. */
export class NativeFileThumbnailProvider extends Disposable {
	private readonly queue = this._register(new Limiter<string | undefined>(2));
	private readonly requests = new Map<string, { windowId: number; cancellation: CancellationTokenSource }>();
	private readonly previews = new LRUCache<string, Promise<string | undefined>>(16);
	private nativeRequests = 0;

	constructor(
		private readonly createThumbnail: ThumbnailFactory,
		private readonly supported: boolean,
		private readonly timeoutMs = 5000,
	) { super(); }

	async get(windowId: number, resource: UriComponents, options: IFileThumbnailOptions = {}): Promise<string | undefined> {
		if (!this.supported || this._store.isDisposed || this.requests.size >= maxPendingRequests || !options || typeof options !== 'object') { return undefined; }
		const requestId = options.requestId ?? generateUuid();
		if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) { return undefined; }
		const key = `${windowId}:${requestId}`;
		if (this.requests.has(key)) { return undefined; }
		const cancellation = new CancellationTokenSource();
		this.requests.set(key, { windowId, cancellation });
		const token = cancellation.token;
		// The queue timeout releases its slot even if a platform provider never answers.
		// nativeRequests separately caps uninterruptible OS work at two calls: subsequent
		// requests use their fallback until those calls finish, rather than piling up.
		const work = this.queue.queue(() => raceTimeout(
			raceCancellation(this.render(resource, options, token).catch(() => undefined), token),
			this.timeoutMs,
			() => cancellation.cancel()
		)).finally(() => {
			this.requests.delete(key);
			cancellation.dispose();
		});
		return raceTimeout(raceCancellation(work, token), this.timeoutMs, () => cancellation.cancel());
	}

	cancel(windowId: number, requestId: string): void {
		if (typeof requestId === 'string') { this.requests.get(`${windowId}:${requestId}`)?.cancellation.cancel(); }
	}

	cancelWindow(windowId: number): void {
		for (const request of this.requests.values()) {
			if (request.windowId === windowId) { request.cancellation.cancel(); }
		}
	}

	private async render(resource: UriComponents, options: IFileThumbnailOptions, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) { return undefined; }
		const uri = URI.revive(resource);
		if (uri.scheme !== Schemas.file || uri.authority || uri.query || uri.fragment) { return undefined; }
		const requestedPath = uri.fsPath;
		if (!isLocalPath(requestedPath) || !previewExtensions.has(extname(requestedPath).toLowerCase())) { return undefined; }
		const filePath = await fs.realpath(requestedPath);
		if (!isLocalPath(filePath) || !previewExtensions.has(extname(filePath).toLowerCase())) { return undefined; }
		const stat = await fs.stat(filePath);
		if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileBytes || token.isCancellationRequested) { return undefined; }
		const size = { width: boundedDimension(options.maxWidth, 320), height: boundedDimension(options.maxHeight, 180) };
		const key = JSON.stringify([filePath, stat.mtimeMs, stat.size, size.width, size.height]);
		let preview = this.previews.get(key);
		if (!preview) {
			if (this.nativeRequests >= 2) { return undefined; }
			// Attachment rerenders may replace a consumer while its native call is still
			// running. Share that work without coupling it to the old consumer's token.
			preview = this.createPreview(filePath, size).catch(() => undefined);
			this.previews.set(key, preview);
			const pending = preview;
			void preview.then(result => { if (!result && this.previews.peek(key) === pending) { this.previews.delete(key); } });
		}
		const result = await preview;
		return token.isCancellationRequested ? undefined : result;
	}

	private async createPreview(filePath: string, size: { width: number; height: number }): Promise<string | undefined> {
		this.nativeRequests++;
		try {
			const image = await this.createThumbnail(filePath, size);
			if (this._store.isDisposed || image.isEmpty()) { return undefined; }
			const original = image.getSize(1);
			if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0 || original.width * original.height > 16 * 1024 * 1024) { return undefined; }
			// Windows ignores the requested height. Normalize every platform's result to
			// the same aspect-preserving bounds, including Retina image representations.
			const scale = Math.min(1, size.width / original.width, size.height / original.height);
			const bounded = image.resize({ width: Math.max(1, Math.floor(original.width * scale)), height: Math.max(1, Math.floor(original.height * scale)), quality: 'good' });
			const bytes = bounded.toPNG({ scaleFactor: 1 });
			if (!bytes.byteLength || bytes.byteLength > maxPreviewBytes) { return undefined; }
			return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
		} finally {
			this.nativeRequests--;
		}
	}

	override dispose(): void {
		for (const request of this.requests.values()) { request.cancellation.cancel(); request.cancellation.dispose(); }
		this.requests.clear();
		this.previews.clear();
		super.dispose();
	}
}

function isLocalPath(filePath: string): boolean {
	return isAbsolute(filePath) && !filePath.includes('\0') && !/^(?:\\\\|\/\/)/.test(filePath);
}

function boundedDimension(value: number | undefined, maximum: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(maximum, Math.floor(value))) : maximum;
}
