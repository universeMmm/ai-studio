/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
// agentHost 剥离：ExportAgentHostDebugLogsAction 已移除
import { ForkConversationAction } from './actions/chatForkActions.js';

registerAction2(ForkConversationAction);
// agentHost 剥离：ExportAgentHostDebugLogsAction 注册已移除
