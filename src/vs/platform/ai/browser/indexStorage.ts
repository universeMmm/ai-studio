/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IndexedDB } from '../../../base/browser/indexedDB.js';
import { abortable } from '../common/indexCancellation.js';
import { IndexStore, isIndexFileMetadata, type IndexFileRecord, type IndexedChunk, type IndexFileMetadata } from '../common/indexStore.js';

interface StoredFile { entries: IndexedChunk[]; metadata?: IndexFileMetadata }

/** Read bounded pages instead of retaining a second complete workspace map on reload. */
export async function createBrowserIndexStore(root: string, maxBytes: number): Promise<IndexStore> {
	const database = await IndexedDB.create('ai-studio-index:' + root, 1, ['files']);
	return new IndexStore({
		async *scanFiles(signal?: AbortSignal): AsyncIterable<IndexFileRecord> {
			let after: IDBValidKey | undefined;
			while (true) {
				signal?.throwIfAborted();
				let keys: IDBRequest<IDBValidKey[]> | undefined;
				let transaction: IDBTransaction | undefined;
				const abort = () => { try { transaction?.abort(); } catch { /* Already completed. */ } };
				signal?.addEventListener('abort', abort, { once: true });
				let values: (StoredFile | IndexedChunk[])[];
				try {
					values = await abortable(database.runInTransaction('files', 'readonly', store => {
						transaction = store.transaction;
						const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
						keys = store.getAllKeys(range, 16);
						return store.getAll(range, 16);
					}), signal);
				} finally { signal?.removeEventListener('abort', abort); }
				if (!values.length) { return; }
				for (let i = 0; i < values.length; i++) {
					signal?.throwIfAborted();
					const value = values[i];
					if (!value || typeof value !== 'object') { continue; }
					const entries = Array.isArray(value) ? value : value.entries;
					if (!Array.isArray(entries)) { continue; }
					const metadata = !Array.isArray(value) && isIndexFileMetadata(value.metadata) ? value.metadata : undefined;
					yield { filePath: String(keys!.result[i]), entries, metadata };
				}
				after = keys!.result.at(-1);
			}
		},
		async replaceFile(filePath, entries, metadata) {
			if (entries.length || metadata) { await database.runInTransaction('files', 'readwrite', store => store.put({ entries, metadata }, filePath)); }
			else { await database.runInTransaction('files', 'readwrite', store => store.delete(filePath)); }
		},
		close: () => database.close(),
	}, undefined, maxBytes);
}
