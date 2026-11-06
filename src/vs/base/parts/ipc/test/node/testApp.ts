/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChannelClient } from '../../common/ipc.js';
import { createChildProcessProtocol, Server } from '../../node/ipc.cp.js';
import { TestChannel, TestService, TestServiceClient } from './testService.js';

const protocol = createChildProcessProtocol();
const parent = new ChannelClient(protocol);
process.once('disconnect', () => parent.dispose());
const server = new Server('test', protocol);
const service = new TestService();
server.registerChannel('test', new TestChannel(service));
server.registerChannel('parent', new TestChannel(new TestServiceClient(parent.getChannel('test'))));
