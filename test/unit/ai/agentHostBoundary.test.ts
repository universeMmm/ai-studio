/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { isAgentHostEnabled } from '../../../src/vs/platform/agentHost/common/agentService.js';
import { getAgentFeedbackAttachmentMetadata, isAgentFeedbackAttachment } from '../../../src/vs/platform/agentHost/common/agentFeedbackAttachments.js';
import { MessageAttachmentKind, type MessageAttachment } from '../../../src/vs/platform/agentHost/common/state/protocol/state.js';
import type { IConfigurationService } from '../../../src/vs/platform/configuration/common/configuration.js';
import { resolveRemoteAuthority } from '../../../src/vs/sessions/browser/openInVSCodeUtils.js';
import type { ISessionsProvidersService } from '../../../src/vs/sessions/services/sessions/browser/sessionsProvidersService.js';

suite('AI Studio Agent Host boundary', () => {
	test('restoring contracts does not enable the upstream host, even with its setting enabled', () => {
		const configuration = { getValue: () => true } as unknown as IConfigurationService;
		assert.equal(isAgentHostEnabled(configuration), false);
	});

	test('retained remote metadata cannot activate a provider or connection', () => {
		const providers = { getProvider() { throw new Error('Unexpected remote provider lookup'); } } as unknown as ISessionsProvidersService;
		const remote = { getEntryByAddress() { throw new Error('Unexpected remote connection lookup'); } };
		for (const id of ['local', 'agenthost-ssh', 'agenthost-tunnel', 'agenthost-websocket']) {
			assert.equal(resolveRemoteAuthority(id, providers, remote), undefined);
		}
	});

	test('feedback attachment contracts retain typed metadata and reject malformed items', () => {
		const attachment: MessageAttachment = {
			type: MessageAttachmentKind.Simple,
			label: 'Review feedback',
			displayKind: 'agentFeedback',
			modelRepresentation: 'Please fix this line',
			_meta: { agentFeedback: { sessionResource: 'test:/session', feedbackItems: [
				{ id: 'one', text: 'Fix', resourceUri: 'file:///test.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
				{ id: 'malformed', range: null },
			] } },
		};
		assert.equal(isAgentFeedbackAttachment(attachment), true);
		assert.equal(getAgentFeedbackAttachmentMetadata(attachment)?.feedbackItems.length, 1);
		assert.equal(getAgentFeedbackAttachmentMetadata({ ...attachment, _meta: {} }), undefined);
	});
});
