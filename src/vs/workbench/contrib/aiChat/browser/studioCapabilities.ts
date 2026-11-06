/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize2, localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { isStudioAdvancedMode } from '../../../common/studioMode.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { getStudioChatAddCapabilities } from '../../chat/browser/attachments/studioChatAddCapabilities.js';
import { ContributionEnablementState, isContributionEnabled } from '../../chat/common/enablement.js';
import { PromptsConfig } from '../../chat/common/promptSyntax/config/config.js';
import { McpCommandIds } from '../../mcp/common/mcpCommandIds.js';
import { IMcpService, McpConnectionState } from '../../mcp/common/mcpTypes.js';

registerAction2(class extends Action2 {
	constructor() { super({ id: 'aiStudio.capabilities.open', title: localize2('studio.capabilities', '技能与连接'), f1: true }); }
	async run(accessor: ServicesAccessor, section?: string): Promise<void> {
		const commands = accessor.get(ICommandService);
		const quickInput = accessor.get(IQuickInputService);
		const mcp = accessor.get(IMcpService);
		const configuration = accessor.get(IConfigurationService);
		const widgets = accessor.get(IChatWidgetService);
		const instantiation = accessor.get(IInstantiationService);
		if (!section) {
			section = (await quickInput.pick([
				{ id: 'skills', label: localize('studio.capabilities.skills', '技能'), description: localize('studio.capabilities.skillsDescription', '添加可重复使用的工作方法') },
				{ id: 'mcp', label: localize('studio.capabilities.mcp', 'MCP 连接'), description: localize('studio.capabilities.mcpDescription', '让助手使用外部服务与工具') },
				{ id: 'plugins', label: localize('studio.capabilities.plugins', '插件'), description: localize('studio.capabilities.pluginsDescription', '管理已添加的技能与工具包') },
			], { title: localize('studio.capabilities', '技能与连接') }))?.id;
		}
		if (!section) { return; }
		if (section === 'mcp') {
			await mcp.activateCollections();
			const servers = mcp.servers.get();
			const pick = await quickInput.pick([
				{ id: '$add', label: localize('studio.mcp.add', '添加 MCP 连接'), description: localize('studio.mcp.addDescription', '使用服务地址或本机程序连接') },
				...servers.map(server => ({ id: server.definition.id, label: server.definition.label, description: !isContributionEnabled(server.enablement.get()) ? localize('studio.mcp.disabled', '已停用') : server.connectionState.get().state === McpConnectionState.Kind.Running ? localize('studio.mcp.connected', '已连接 · {0} 个工具', server.tools.get().length) : server.connectionState.get().state === McpConnectionState.Kind.Error ? localize('studio.mcp.error', '连接失败') : localize('studio.mcp.disconnected', '未连接') })),
			], { title: localize('studio.capabilities.mcp', 'MCP 连接'), placeHolder: localize('studio.mcp.placeholder', '选择连接以查看工具、连接或停用') });
			if (!pick) { return; }
			if (pick.id === '$add') { await commands.executeCommand(McpCommandIds.AddConfiguration); return; }
			const server = servers.find(server => server.definition.id === pick.id);
			if (!server) { return; }
			const enabled = isContributionEnabled(server.enablement.get());
			const items = [
				{ id: 'connect', label: localize('studio.mcp.connect', '连接 / 重新连接') },
				{ id: 'tools', label: localize('studio.mcp.tools', '查看可用工具') },
				{ id: 'toggle', label: enabled ? localize('studio.mcp.disable', '停用连接') : localize('studio.mcp.enable', '启用连接') },
			];
			if (isStudioAdvancedMode(configuration)) { items.push({ id: 'advanced', label: localize('studio.mcp.advanced', '更多连接设置') }); }
			const action = await quickInput.pick(items, { title: server.definition.label });
			if (action?.id === 'toggle') {
				mcp.enablementModel.setEnabled(server.definition.id, enabled ? ContributionEnablementState.DisabledProfile : ContributionEnablementState.EnabledProfile);
				if (enabled) { await server.stop(); }
			} else if (action?.id === 'connect') {
				mcp.enablementModel.setEnabled(server.definition.id, ContributionEnablementState.EnabledProfile);
				await server.stop();
				await commands.executeCommand(McpCommandIds.StartServer, server.definition.id, { promptType: 'all-untrusted', waitForLiveTools: true });
			} else if (action?.id === 'tools') {
				await quickInput.pick(server.tools.get().map(tool => ({ label: tool.definition.annotations?.title || tool.definition.name, description: tool.definition.description })), { title: localize('studio.mcp.toolsTitle', '{0} · 可用工具', server.definition.label), placeHolder: localize('studio.mcp.toolsHint', '这些工具可在会话中由助手调用') });
			} else if (action?.id === 'advanced') { await commands.executeCommand(McpCommandIds.ServerOptions, server.definition.id); }
			return;
		}
		if (section === 'skills') {
			const pick = await quickInput.pick([
				{ id: 'attach', label: localize('studio.skills.use', '在当前会话使用技能') },
				{ id: 'aiStudio.skills.import', label: localize('studio.skills.import', '添加本机技能文件夹') },
				{ id: 'workbench.command.new.skill', label: localize('studio.skills.create', '创建技能') },
				{ id: 'workbench.action.chat.configure.skills', label: localize('studio.skills.manage', '查看和编辑技能') },
			], { title: localize('studio.capabilities.skills', '技能') });
			if (!pick) { return; }
			if (pick.id !== 'attach') { await commands.executeCommand(pick.id); return; }
		}
		const widget = widgets.lastFocusedWidget ?? await widgets.revealWidget();
		if (!widget) { return; }
		const capabilities = await instantiation.invokeFunction(getStudioChatAddCapabilities, widget, CancellationToken.None);
		await capabilities.find(capability => capability.id === (section === 'skills' ? 'studio.chat.add.skill' : 'studio.chat.manage.plugins'))?.run();
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'aiStudio.skills.import', title: localize2('studio.skills.import', '添加本机技能文件夹'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogs = accessor.get(IFileDialogService);
		const files = accessor.get(IFileService);
		const configuration = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		const folder = (await dialogs.showOpenDialog({ title: localize('studio.skills.selectFolder', '选择包含技能子文件夹的目录'), canSelectFolders: true, canSelectFiles: false, canSelectMany: false, availableFileSystems: [Schemas.file] }))?.[0];
		if (!folder) { return; }
		const children = (await files.resolve(folder)).children ?? [];
		let valid = false;
		for (const child of children) {
			if (child.isDirectory && await files.exists(joinPath(child.resource, 'SKILL.md'))) { valid = true; break; }
		}
		if (!valid) { notifications.warn(localize('studio.skills.invalid', '请选择技能集合文件夹：每个子文件夹中应有一个 SKILL.md 文件。')); return; }
		const locations = configuration.inspect<Record<string, boolean>>(PromptsConfig.SKILLS_LOCATION_KEY).userLocalValue ?? {};
		await configuration.updateValue(PromptsConfig.SKILLS_LOCATION_KEY, { ...locations, [folder.fsPath]: true }, ConfigurationTarget.USER_LOCAL);
		notifications.info(localize('studio.skills.added', '技能文件夹已添加，可从输入框「+ → 添加技能」中选择。'));
	}
});
