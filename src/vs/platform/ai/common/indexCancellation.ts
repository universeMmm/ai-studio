/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { setTimeout0 } from '../../../base/common/platform.js';

/** Yield a task without Chromium's nested-timer 4 ms clamp. */
export async function yieldIndexTask(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await abortable(new Promise<void>(resolve => setTimeout0(resolve)), signal);
	signal?.throwIfAborted();
}

/** Also stops waiting for providers/file systems which cannot themselves cancel an operation. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) { return promise; }
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
		if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

export function indexDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) { return yieldIndexTask(signal); }
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}
