/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fse from 'fs-extra';
import path from 'path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'notebook');
const outDir = path.join(import.meta.dirname, 'notebook-out');

function postBuild(outDir: string) {
	fse.ensureDirSync(outDir);
	fse.writeFileSync(
		path.join(outDir, 'katex.min.css'),
		fse.readFileSync(path.join(import.meta.dirname, 'node_modules', 'katex', 'dist', 'katex.min.css')));

	const fontsDir = path.join(import.meta.dirname, 'node_modules', 'katex', 'dist', 'fonts');
	const fontsOutDir = path.join(outDir, 'fonts/');

	fse.mkdirSync(fontsOutDir, { recursive: true });

	for (const file of fse.readdirSync(fontsDir)) {
		if (file.endsWith('.woff2')) {
			fse.writeFileSync(
				path.join(fontsOutDir, file),
				fse.readFileSync(path.join(fontsDir, file)));
		}
	}
}

run({
	entryPoints: [
		path.join(srcDir, 'katex.ts'),
	],
	srcDir,
	outdir: outDir,
}, process.argv, postBuild);
