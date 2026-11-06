/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.AI_STUDIO_ELECTRON || path.join(root, '.build/electron/AI Studio.app/Contents/MacOS/AI Studio');
const report = path.join(root, '.build/opencode-validation/report.json');
await mkdir(path.dirname(report), { recursive: true });
const env = { ...process.env, AI_STUDIO_OPENCODE_REPORT: report };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [fileURLToPath(new URL('./electron.cjs', import.meta.url))], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
child.on('error', error => { console.error(error); process.exitCode = 1; clearTimeout(timer); });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; console.log(`Report: ${report}`); });
