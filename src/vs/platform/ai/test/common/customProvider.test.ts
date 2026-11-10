/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { CustomProvider } from '../../common/customProvider.js';
import type { AIMessage } from '../../common/aiTypes.js';

suite('CustomProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('batched embeddings respect response indices and reject missing or duplicate vectors', async () => {
		const fetch = globalThis.fetch;
		const provider = new CustomProvider('https://example.invalid/v1', 'fixture', 'fixture', new NullLogService());
		try {
			globalThis.fetch = async () => Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
			assert.deepStrictEqual(await provider.embed(['a', 'b']), [[1, 0], [0, 1]]);
			globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1] }] });
			await assert.rejects(provider.embed(['a', 'b']), /length/);
			globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] });
			await assert.rejects(provider.embed(['a', 'b']), /order/);
		} finally { globalThis.fetch = fetch; provider.dispose(); }
	});

	test('converts tool result messages to OpenAI chat completion format', () => {
		const provider = new CustomProvider('https://example.invalid/v1', 'test-key', 'test-model', new NullLogService());
		const messages: AIMessage[] = [{
			role: 'tool',
			content: [{
				type: 'tool_result',
				tool_use_id: 'call_123',
				content: 'read complete',
				is_error: false,
			}],
		}];

		const converted = provider['_convertMessages'](messages);

		assert.deepStrictEqual(converted, [{
			role: 'tool',
			tool_call_id: 'call_123',
			content: 'read complete',
		}]);
		provider.dispose();
	});
});
