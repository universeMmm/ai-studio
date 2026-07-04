/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// STUB — agentHost 已剥离，此文件为占位桩模块


export type IRemoteAgentHostWebSocketConnection = any;

export type IRemoteAgentHostSSHConnection = any;

export type IRemoteAgentHostTunnelConnection = any;

export type IRemoteAgentHostEntry = any;

export type IParsedRemoteAgentHostInput = any;

export type IRemoteAgentHostService = any;

export type IRemoteAgentHostConnectionInfo = any;

export type IRawRemoteAgentHostEntry = any;

export type RemoteAgentHostConnectionStatus = any;

export type RemoteAgentHostConnection = any;

export type RemoteAgentHostInputParseResult = any;

export class NullRemoteAgentHostService {
	// STUB: agentHost 已剥离
}

export function incompatible(..._args: any[]): any {
	throw new Error('agentHost stub: incompatible is not available');
}

export function isConnected(..._args: any[]): any {
	throw new Error('agentHost stub: isConnected is not available');
}

export function isConnecting(..._args: any[]): any {
	throw new Error('agentHost stub: isConnecting is not available');
}

export function isDisconnected(..._args: any[]): any {
	throw new Error('agentHost stub: isDisconnected is not available');
}

export function isIncompatible(..._args: any[]): any {
	throw new Error('agentHost stub: isIncompatible is not available');
}

export function isUnavailable(..._args: any[]): any {
	throw new Error('agentHost stub: isUnavailable is not available');
}

export function fromConnectError(..._args: any[]): any {
	throw new Error('agentHost stub: fromConnectError is not available');
}

export function getEntryAddress(..._args: any[]): any {
	throw new Error('agentHost stub: getEntryAddress is not available');
}

export function parseRemoteAgentHostInput(..._args: any[]): any {
	throw new Error('agentHost stub: parseRemoteAgentHostInput is not available');
}

export function rawEntryToEntry(..._args: any[]): any {
	throw new Error('agentHost stub: rawEntryToEntry is not available');
}

export function entryToRawEntry(..._args: any[]): any {
	throw new Error('agentHost stub: entryToRawEntry is not available');
}

export const connected: any = undefined as any;

export const connecting: any = undefined as any;

export const disconnected: any = undefined as any;

export const RemoteAgentHostsSettingId: any = undefined as any;

export const RemoteAgentHostsEnabledSettingId: any = undefined as any;

export const RemoteAgentHostAutoConnectSettingId: any = undefined as any;

export enum RemoteAgentHostEntryType {}

export enum RemoteAgentHostInputValidationError {}

export namespace RemoteAgentHostConnectionStatus {}
