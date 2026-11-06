/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Tool names shared by chat messages and the task inspector.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

const names: Record<string, string> = {
	read_file: localize('studio.tool.read', "读取文件"), write_file: localize('studio.tool.write', "写入文件"),
	edit_file: localize('studio.tool.edit', "编辑文件"), list_directory: localize('studio.tool.list', "查看目录"),
	search_files: localize('studio.tool.files', "查找文件"), search_pattern: localize('studio.tool.pattern', "搜索文本"),
	search_content: localize('studio.tool.index', "检索代码"), read_lints: localize('studio.tool.lints', "查看诊断"),
	web_fetch: localize('studio.tool.fetch', "读取网页"), web_search: localize('studio.tool.search', "搜索网页"),
	run_command: localize('studio.tool.shell', "运行命令"), Agent: localize('studio.tool.agent', "调用子智能体"),
	TaskCreate: localize('studio.tool.taskAdd', "创建任务"), TaskUpdate: localize('studio.tool.taskUpdate', "更新任务"),
	TaskList: localize('studio.tool.taskList', "查看任务"), TaskGet: localize('studio.tool.taskGet', "获取任务"),
	EnterPlanMode: localize('studio.tool.plan', "开始规划"), ExitPlanMode: localize('studio.tool.planReview', "提交计划"),
	SendMessage: localize('studio.tool.message', "发送消息"), LocalMemoryRecall: localize('studio.tool.memory', "查找记忆"),
	AskUserQuestion: localize('studio.tool.question', "确认需求"),
};

export function studioToolLabel(tool: string, parameters?: Record<string, unknown>): string {
	const label = names[tool] ?? tool;
	if (!parameters) { return label; }
	const target = parameters.path ?? parameters.query ?? parameters.pattern ?? parameters.command ?? parameters.url;
	return typeof target === 'string' && target ? label + ' · ' + target.replace(/\s+/g, ' ').slice(0, 100) : label;
}
