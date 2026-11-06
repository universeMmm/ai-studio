/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChannelClient } from '../../../../base/parts/ipc/common/ipc.js';
import { createChildProcessProtocol, Server } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { TelemetryAppenderChannel } from '../../../../platform/telemetry/common/telemetryIpc.js';
import { OneDataSystemAppender } from '../../../../platform/telemetry/node/1dsAppender.js';

const protocol = createChildProcessProtocol();
const parent = new ChannelClient(protocol);
process.once('disconnect', () => parent.dispose());
const requestService = new RequestChannelClient(parent.getChannel('request'));
const appender = new OneDataSystemAppender(requestService, false, process.argv[2], JSON.parse(process.argv[3]), process.argv[4]);
process.once('exit', () => appender.flush());

const channel = new TelemetryAppenderChannel([appender]);
const server = new Server('telemetry', protocol);
server.registerChannel('telemetryAppender', channel);
