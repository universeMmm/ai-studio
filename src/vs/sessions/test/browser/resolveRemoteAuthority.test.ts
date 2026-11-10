/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { resolveRemoteAuthority } from '../../browser/openInVSCodeUtils.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';

suite('resolveRemoteAuthority (AI Studio)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// AI Studio does not register Agent Host providers. Restored protocol types
	// must not make retained SSH/tunnel metadata activate a remote connection.
	for (const providerId of ['local-provider', 'agenthost-ssh', 'agenthost-tunnel', 'agenthost-websocket']) {
		test(`does not resolve or contact ${providerId}`, () => {
			const providers = {
				getProvider() { throw new Error('Disabled Agent Host provider was accessed'); },
			} as unknown as ISessionsProvidersService;
			const remote = {
				getEntryByAddress() { throw new Error('Disabled Agent Host connection was accessed'); },
			};
			assert.strictEqual(resolveRemoteAuthority(providerId, providers, remote), undefined);
		});
	}
});
