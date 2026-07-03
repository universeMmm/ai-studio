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

		const converted = (provider as any)._convertMessages(messages);

		assert.deepStrictEqual(converted, [{
			role: 'tool',
			tool_call_id: 'call_123',
			content: 'read complete',
		}]);
		provider.dispose();
	});
});
