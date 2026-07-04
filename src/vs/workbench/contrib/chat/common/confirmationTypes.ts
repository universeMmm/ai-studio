/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// agentHost 剥离后，确认选项类型不再由 agentHost 协议模块提供。
// 此文件包含这些类型的本地定义，供 chat 工作台组件使用。

export const enum ConfirmationOptionKind {
	Approve = 'approve',
	Deny = 'deny',
}

export interface ConfirmationOption {
	/** 唯一标识符 */
	id: string;
	/** 按钮类型 */
	kind: ConfirmationOptionKind;
	/** 显示标签 */
	label?: string;
	/** 分组编号 */
	group?: number;
}
