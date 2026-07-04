/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// agentHost 剥离：本地定义替换原 agentHost 协议模块引用
export interface ResolveSessionConfigResult {
	schema: { required?: readonly string[] };
	values: Record<string, unknown>;
}

export function isSessionConfigComplete(config: ResolveSessionConfigResult): boolean {
	return (config.schema.required ?? []).every(property => config.values[property] !== undefined);
}
