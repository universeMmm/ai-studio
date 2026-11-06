/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NativeFileThumbnailProvider } from '../../node/fileThumbnail.js';

suite('NativeFileThumbnailProvider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;
	let fixture: URI;
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5b8AAAAASUVORK5CYII=', 'base64');
	const image = () => ({
		isEmpty: () => false,
		getSize: () => ({ width: 400, height: 1600 }),
		resize: (_size: { width: number; height: number }) => image(),
		toPNG: () => png,
	});

	setup(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), 'studio-thumbnail-test-'));
		fixture = URI.file(join(directory, 'generated-fixture.pdf'));
		await fs.writeFile(fixture.fsPath, '%PDF-1.4\nGenerated isolated test fixture.\n');
	});

	teardown(async () => { await fs.rm(directory, { recursive: true, force: true }); });

	test('bounds platform output and returns only an in-memory PNG', async () => {
		let requested: { width: number; height: number } | undefined;
		let resized: { width: number; height: number } | undefined;
		const provider = store.add(new NativeFileThumbnailProvider(async (filePath, size) => {
			assert.strictEqual(filePath, await fs.realpath(fixture.fsPath));
			requested = size;
			return { ...image(), resize: size => { resized = size; return image(); } };
		}, true));
		assert.strictEqual(await provider.get(1, fixture, { maxWidth: 4000, maxHeight: 4000 }), `data:image/png;base64,${png.toString('base64')}`);
		assert.deepStrictEqual(requested, { width: 320, height: 180 });
		assert.deepStrictEqual(resized, { width: 45, height: 180, quality: 'good' });
		assert.deepStrictEqual(await fs.readdir(directory), ['generated-fixture.pdf']);
	});

	test('rejects remote, UNC, absent, directory, and unsupported inputs before invoking the platform', async () => {
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider(async () => { calls++; return image(); }, true));
		await fs.mkdir(join(directory, 'folder.pdf'));
		await fs.writeFile(join(directory, 'page.html'), '<html>fixture</html>');
		for (const resource of [
			URI.parse('https://example.invalid/document.pdf'), URI.parse('vscode-remote://host/document.pdf'),
			URI.parse('file://host/document.pdf'), URI.file('//host/document.pdf'),
			URI.file(join(directory, 'missing.pdf')), URI.file(join(directory, 'folder.pdf')), URI.file(join(directory, 'page.html')),
			fixture.with({ query: 'preview=1' }),
		]) { assert.strictEqual(await provider.get(1, resource), undefined); }
		assert.strictEqual(calls, 0);
	});

	test('unsupported platforms, oversized files, and symlinks to unsupported files fall back', async () => {
		let calls = 0;
		const factory = async () => { calls++; return image(); };
		assert.strictEqual(await store.add(new NativeFileThumbnailProvider(factory, false)).get(1, fixture), undefined);
		const large = URI.file(join(directory, 'large.pdf'));
		const handle = await fs.open(large.fsPath, 'w');
		try { await handle.truncate(50 * 1024 * 1024 + 1); } finally { await handle.close(); }
		const provider = store.add(new NativeFileThumbnailProvider(factory, true));
		assert.strictEqual(await provider.get(1, large), undefined);
		const unsupported = join(directory, 'untrusted.html');
		await fs.writeFile(unsupported, 'fixture');
		const link = URI.file(join(directory, 'linked.pdf'));
		await fs.symlink(unsupported, link.fsPath);
		assert.strictEqual(await provider.get(1, link), undefined);
		assert.strictEqual(calls, 0);
	});

	test('window-scoped cancellation discards only the matching request', async () => {
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<ReturnType<typeof image>>();
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider(() => { if (++calls === 1) { started.complete(); } return finish.p; }, true));
		const first = provider.get(1, fixture, { requestId: 'same-id' });
		const second = provider.get(2, fixture, { requestId: 'same-id' });
		assert.strictEqual(await provider.get(1, fixture, { requestId: 'same-id' }), undefined);
		await started.p;
		provider.cancel(3, 'same-id');
		provider.cancel(1, 'same-id');
		assert.strictEqual(await first, undefined);
		const replacement = provider.get(1, fixture, { requestId: 'replacement-id' });
		finish.complete(image());
		assert.ok((await second)?.startsWith('data:image/png;base64,'));
		assert.ok((await replacement)?.startsWith('data:image/png;base64,'));
		assert.ok((await provider.get(1, fixture))?.startsWith('data:image/png;base64,'));
		assert.strictEqual(calls, 1, 'same local file should share an in-flight thumbnail across consumers');
		await fs.appendFile(fixture.fsPath, 'Changed fixture bytes.');
		assert.ok((await provider.get(1, fixture))?.startsWith('data:image/png;base64,'));
		assert.strictEqual(calls, 2, 'changed files must invalidate the previous preview');
	});

	test('cancelled queued requests never start a native operation', async () => {
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<ReturnType<typeof image>>();
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider(() => { if (++calls === 2) { started.complete(); } return finish.p; }, true));
		const first = provider.get(1, fixture);
		const second = provider.get(1, fixture, { maxWidth: 160 });
		await started.p;
		const queued = provider.get(1, fixture, { requestId: 'removed-attachment', maxWidth: 80 });
		provider.cancel(1, 'removed-attachment');
		assert.strictEqual(await queued, undefined);
		finish.complete(image());
		await Promise.all([first, second]);
		assert.strictEqual(calls, 2);
	});

	test('timeouts drain the queue without exceeding two unfinished OS operations', async () => {
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<ReturnType<typeof image>>();
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider(() => {
			if (++calls === 2) { started.complete(); }
			return calls <= 2 ? finish.p : Promise.resolve(image());
		}, true, 100));
		const first = provider.get(1, fixture);
		const second = provider.get(1, fixture, { maxWidth: 160 });
		await started.p;
		assert.deepStrictEqual(await Promise.all([first, second, provider.get(1, fixture, { maxWidth: 80 })]), [undefined, undefined, undefined]);
		assert.strictEqual(await provider.get(1, fixture, { maxWidth: 40 }), undefined);
		assert.strictEqual(calls, 2);
		finish.complete(image());
		await timeout(0);
		assert.ok((await provider.get(1, fixture))?.startsWith('data:image/png;base64,'));
	});

	test('queue capacity and closed-window cancellation are bounded', async () => {
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<ReturnType<typeof image>>();
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider(() => { if (++calls === 2) { started.complete(); } return finish.p; }, true));
		const pending = Array.from({ length: 32 }, (_, index) => provider.get(1, fixture, { maxWidth: 320 - index }));
		await started.p;
		assert.strictEqual(await provider.get(1, fixture), undefined);
		provider.cancelWindow(1);
		assert.ok((await Promise.all(pending)).every(value => value === undefined));
		finish.complete(image());
		await timeout(0);
		assert.strictEqual(calls, 2);
	});

	test('native errors and oversized encoded output use the fallback', async () => {
		const failed = store.add(new NativeFileThumbnailProvider(async () => { throw new Error('Synthetic platform failure'); }, true));
		assert.strictEqual(await failed.get(1, fixture), undefined);
		const oversized = { ...image(), toPNG: () => Buffer.alloc(512 * 1024 + 1) };
		oversized.resize = () => oversized;
		const large = store.add(new NativeFileThumbnailProvider(async () => oversized, true));
		assert.strictEqual(await large.get(1, fixture), undefined);
		const empty = store.add(new NativeFileThumbnailProvider(async () => ({ ...image(), isEmpty: () => true }), true));
		assert.strictEqual(await empty.get(1, fixture), undefined);
	});

	test('invalid dimensions are normalized and disposal settles queued consumers', async () => {
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<ReturnType<typeof image>>();
		let calls = 0;
		const provider = store.add(new NativeFileThumbnailProvider((_filePath, size) => {
			assert.deepStrictEqual(size, { width: 320, height: 180 });
			if (++calls === 1) { started.complete(); }
			return finish.p;
		}, true));
		const pending = Array.from({ length: 3 }, () => provider.get(1, fixture, { maxWidth: Infinity, maxHeight: -1 }));
		await started.p;
		provider.dispose();
		assert.deepStrictEqual(await Promise.all(pending), [undefined, undefined, undefined]);
		assert.strictEqual(await provider.get(1, fixture), undefined);
		finish.complete(image());
	});
});
