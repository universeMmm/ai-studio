/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extname } from '../../../../../base/common/path.js';
import { isNative } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IChatRequestVariableEntry } from '../../common/attachments/chatVariableEntries.js';

/** Adds a visual preview without changing the attachment's open, delete or request behavior. */
export function renderStudioAttachmentCard(element: HTMLElement, attachment: IChatRequestVariableEntry, resource: URI | undefined, imageData?: Uint8Array, instantiationService?: IInstantiationService): IDisposable {
	if (!element.closest('.studio-chat-editor') || !element.closest('.chat-input-container')) {
		return Disposable.None;
	}

	const store = new DisposableStore();
	const extension = extname(resource?.path ?? attachment.name).slice(1).toUpperCase();
	const icon = attachment.kind === 'directory' ? Codicon.folder : attachment.kind === 'image' ? Codicon.fileMedia : extension === 'PDF' ? Codicon.filePdf : Codicon.fileText;
	element.classList.add('studio-attachment-card');
	element.dataset.attachmentKind = attachment.kind;
	element.dataset.preview = 'fallback';
	const footer = dom.$('.studio-attachment-footer');
	const typeIcon = dom.append(footer, dom.$('span.studio-attachment-type-icon'));
	typeIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
	typeIcon.setAttribute('aria-hidden', 'true');
	for (const child of Array.from(element.children)) {
		if (!child.classList.contains('monaco-button')) {
			if (attachment.kind === 'image' && (child.classList.contains('chat-attached-context-pill') || child.classList.contains('monaco-icon-label'))) {
				(child as HTMLElement).hidden = true;
			}
			footer.appendChild(child);
		}
	}
	const preview = dom.$('.studio-attachment-preview');
	preview.setAttribute('aria-hidden', 'true');
	const fallback = dom.append(preview, dom.$('.studio-attachment-fallback'));
	dom.append(fallback, dom.$('span', { class: ThemeIcon.asClassName(icon) }));
	dom.append(fallback, dom.$('span.studio-attachment-format', {}, attachment.kind === 'directory' ? localize('studio.attachment.folder', '文件夹') : extension || localize('studio.attachment.file', '文件')));
	element.append(preview, footer);
	footer.title = attachment.name;

	const showImage = (src: string, source: 'image' | 'system') => {
		if (store.isDisposed || !element.isConnected) { return; }
		const image = dom.$<HTMLImageElement>('img.studio-attachment-thumbnail', { alt: '', draggable: 'false' });
		store.add(dom.addDisposableListener(image, 'load', () => {
			if (store.isDisposed || !element.isConnected) { return; }
			fallback.hidden = true;
			image.classList.add('loaded');
			element.dataset.preview = source;
		}));
		store.add(dom.addDisposableListener(image, 'error', () => {
			image.remove();
			if (!store.isDisposed && element.isConnected) { element.dataset.preview = 'fallback'; }
		}));
		preview.appendChild(image);
		image.src = src;
		return image;
	};

	if (imageData) {
		const url = URL.createObjectURL(new Blob([imageData as Uint8Array<ArrayBuffer>]));
		const image = showImage(url, 'image');
		store.add(toDisposable(() => {
			// Stop queued decodes before releasing the URL during rapid re-renders.
			image?.removeAttribute('src');
			URL.revokeObjectURL(url);
		}));
	} else if (attachment.kind === 'file' && resource?.scheme === Schemas.file && isNative && instantiationService) {
		let nativeHost: INativeHostService | undefined;
		try { nativeHost = instantiationService.invokeFunction(accessor => accessor.get(INativeHostService)); } catch { /* Web and test hosts keep the file-type preview. */ }
		if (nativeHost) {
			const requestId = generateUuid();
			const host = nativeHost;
			let pending = true;
			element.dataset.preview = 'loading';
			const showFallback = () => { if (!store.isDisposed && element.isConnected) { element.dataset.preview = 'fallback'; } };
			store.add(toDisposable(() => { if (pending) { void host.cancelFileThumbnail(requestId).catch(() => { }); } }));
			void host.getFileThumbnail(resource, { maxWidth: 320, maxHeight: 180, requestId }).then(thumbnail => {
				pending = false;
				if (thumbnail?.startsWith('data:image/png;base64,')) { showImage(thumbnail, 'system'); }
				else { showFallback(); }
			}, () => { pending = false; showFallback(); });
		}
	}
	return store;
}
