/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
globalThis._VSCODE_PRODUCT_JSON = JSON.parse(readFileSync(new URL('product.json', root), 'utf8'));
globalThis._VSCODE_PACKAGE_JSON = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
globalThis._VSCODE_FILE_ROOT = new URL('.build/test-ai/src/', root).href;

// Model tests install their own responses. Never send test credentials to a provider.
globalThis.fetch = async () => { throw new Error('Network access is disabled in AI unit tests'); };
