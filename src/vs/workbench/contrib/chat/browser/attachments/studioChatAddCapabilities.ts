/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { parse as parseJSONC, ParseError } from '../../../../../base/common/json.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { detectPluginFormat } from '../../../../../platform/agentPlugins/common/pluginParsers.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { PromptFileVariableKind, toPromptFileVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ICustomizationHarnessService } from '../../common/customizationHarnessService.js';
import { isContributionEnabled } from '../../common/enablement.js';
import { IAgentPlugin, IAgentPluginService } from '../../common/plugins/agentPluginService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IChatPromptSlashCommand } from '../../common/promptSyntax/service/promptsService.js';
import { AgentPluginEditorInput } from '../agentPluginEditor/agentPluginEditorInput.js';
import { AgentPluginItemKind } from '../agentPluginEditor/agentPluginItems.js';
import { IChatWidget } from '../chat.js';

export interface IStudioChatAddCapability {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon: ThemeIcon;
	readonly section: 'skills' | 'plugins' | 'mcp';
	run(): Promise<void>;
}

/**
 * Provides real, installed skills and the existing plugin management actions.
 * Skills remain ordinary prompt-file attachments; plugin entries open their
 * management UI and do not claim to enable tools in the Studio agent runtime.
 */
export async function getStudioChatAddCapabilities(
	accessor: ServicesAccessor,
	widget: IChatWidget,
	token: CancellationToken,
): Promise<readonly IStudioChatAddCapability[]> {
	const commandService = accessor.get(ICommandService);
	const harnessService = accessor.get(ICustomizationHarnessService);
	const pluginService = accessor.get(IAgentPluginService);
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);
	const quickInputService = accessor.get(IQuickInputService);
	const fileDialogService = accessor.get(IFileDialogService);
	const fileService = accessor.get(IFileService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const sessionResource = widget.viewModel?.sessionResource;
	const result: IStudioChatAddCapability[] = [];
	if (token.isCancellationRequested) {
		return result;
	}

	if (sessionResource && widget.attachmentCapabilities.supportsPromptAttachments) {
		result.push({
			id: 'studio.chat.add.skill',
			label: localize('studio.add.skill', '添加技能'),
			description: localize('studio.add.skill.description', '选择技能并附加到当前会话'),
			icon: Codicon.lightbulb,
			section: 'skills',
			run: async () => {
				type SkillPick = IQuickPickItem & { skill?: IChatPromptSlashCommand; commandId?: string };
				// The parent menu's cancellation token ends when it closes. The
				// subsequent picker must keep its own lifetime until selection/cancel.
				const picks = harnessService.getSlashCommands(sessionResource, CancellationToken.None).then(commands => {
					const items: (SkillPick | IQuickPickSeparator)[] = [];
					const seen = new Set<string>();
					for (const skill of commands.filter(command => command.type === PromptsType.skill && command.userInvocable).sort((a, b) => a.name.localeCompare(b.name))) {
						const key = skill.uri.toString();
						if (seen.has(key)) {
							continue;
						}
						seen.add(key);
						items.push({ label: skill.name, description: skill.description, skill });
					}
					items.push(
						{ type: 'separator', label: localize('studio.add.skill.setup', '技能设置') },
						{ label: localize('studio.add.newSkill', '创建技能'), description: localize('studio.add.newSkill.description', '创建可重复使用的 SKILL.md'), commandId: 'workbench.command.new.skill', alwaysShow: true },
					);
					return items;
				});
				const pick = await quickInputService.pick<SkillPick>(picks, {
					title: localize('studio.add.skill', '添加技能'),
					placeHolder: localize('studio.add.skill.placeholder', '搜索已配置的技能，或创建新技能'),
					matchOnDescription: true,
				});
				if (pick?.commandId) {
					await commandService.executeCommand(pick.commandId);
					return;
				}
				if (widget.domNode.isConnected && widget.viewModel?.sessionResource.toString() === sessionResource.toString()) {
					if (pick?.skill) {
						widget.attachmentModel.addContext(toPromptFileVariableEntry(pick.skill.uri, PromptFileVariableKind.PromptFile, pick.skill.name));
					}
					widget.focusInput();
				}
			},
		});
	}

	const command = (id: string, label: string, description: string, icon: ThemeIcon, section: IStudioChatAddCapability['section']): IStudioChatAddCapability => ({
		id,
		label,
		description,
		icon,
		section,
		run: async () => { await commandService.executeCommand(id); },
	});
	result.push(command('workbench.action.chat.configure.skills', localize('studio.add.manageSkills', '管理技能'), localize('studio.add.manageSkills.description', '查看已配置的技能文件'), Codicon.settingsGear, 'skills'));
	result.push(command('aiStudio.skills.import', localize('studio.add.importSkills', '添加技能文件夹'), localize('studio.add.importSkills.description', '使用本机已有的技能'), Codicon.folder, 'skills'));
	result.push({ id: 'studio.chat.manage.mcp', label: localize('studio.add.mcp', 'MCP 连接'), description: localize('studio.add.mcp.description', '添加服务，管理助手可用的工具'), icon: Codicon.mcp, section: 'mcp', run: async () => { await commandService.executeCommand('aiStudio.capabilities.open', 'mcp'); } });

	const openPlugin = async (plugin: IAgentPlugin): Promise<void> => {
		const name = plugin.label || basename(plugin.uri);
		const description = plugin.fromMarketplace?.description || localize('studio.add.installedPlugin', '查看插件详情与配置');
		await editorService.openEditor(instantiationService.createInstance(AgentPluginEditorInput, {
			kind: AgentPluginItemKind.Installed,
			name,
			description,
			marketplace: plugin.fromMarketplace?.marketplace,
			plugin,
		}));
	};
	const addLocalPlugin = async (): Promise<void> => {
		try {
			const folders = await fileDialogService.showOpenDialog({
				title: localize('studio.add.localPlugin', '选择本机插件文件夹'),
				openLabel: localize('studio.add.localPlugin.accept', '添加插件'),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				availableFileSystems: [Schemas.file],
			});
			const folder = folders?.[0];
			if (!folder) {
				return;
			}
			if (folder.scheme !== Schemas.file || !(await fileService.resolve(folder)).isDirectory) {
				throw new Error(localize('studio.add.localPlugin.notDirectory', '请选择本机插件文件夹。'));
			}
			// Use the same format detection and JSON parser as native discovery.
			// Registration changes discovery only, not the agent's file access policy.
			const format = await detectPluginFormat(folder, fileService);
			const manifestUri = joinPath(folder, format.manifestPath);
			if (!await fileService.exists(manifestUri)) {
				throw new Error(localize('studio.add.localPlugin.invalidManifest', '未找到有效的插件清单：{0}。请选择包含插件清单的根文件夹。', format.manifestPath));
			}
			const content = await fileService.readFile(manifestUri, { limits: { size: 1024 * 1024 } });
			const errors: ParseError[] = [];
			const manifest = parseJSONC(content.value.toString(), errors);
			if (errors.length || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
				throw new Error(localize('studio.add.localPlugin.invalidManifest', '未找到有效的插件清单：{0}。请选择包含插件清单的根文件夹。', format.manifestPath));
			}
			const configured = configurationService.inspect<Record<string, boolean>>(ChatConfiguration.PluginLocations).userLocalValue ?? {};
			await configurationService.updateValue(ChatConfiguration.PluginLocations, { ...configured, [folder.fsPath]: true }, ConfigurationTarget.USER_LOCAL);
		} catch (error) {
			notificationService.error(error instanceof Error ? error : String(error));
		} finally {
			if (widget.domNode.isConnected && widget.viewModel?.sessionResource.toString() === sessionResource?.toString()) {
				widget.focusInput();
			}
		}
	};
	result.push({
		id: 'studio.chat.add.localPlugin',
		label: localize('studio.add.installPlugin', '添加插件'),
		description: localize('studio.add.localPlugin', '选择本机插件文件夹'),
		icon: Codicon.add,
		section: 'plugins',
		run: addLocalPlugin,
	}, {
		id: 'studio.chat.manage.plugins',
		label: localize('studio.add.managePlugins', '管理插件'),
		description: localize('studio.add.managePlugins.description', '查看已添加的插件和配置'),
		icon: Codicon.extensions,
		section: 'plugins',
		run: async () => {
			type PluginPick = IQuickPickItem & { plugin?: IAgentPlugin; add?: boolean };
			const picks: (PluginPick | IQuickPickSeparator)[] = [...pluginService.plugins.get()].sort((a, b) => a.label.localeCompare(b.label)).map(plugin => ({
				label: plugin.label || basename(plugin.uri),
				description: isContributionEnabled(plugin.enablement.get()) ? localize('studio.add.plugin.enabled', '已启用') : localize('studio.add.plugin.disabled', '已停用'),
				detail: plugin.uri.fsPath,
				plugin,
			}));
			picks.push(
				{ type: 'separator' },
				{ label: localize('studio.add.installPlugin', '添加插件'), description: localize('studio.add.localPlugin', '选择本机插件文件夹'), add: true, alwaysShow: true },
			);
			const pick = await quickInputService.pick<PluginPick>(picks, {
				title: localize('studio.add.managePlugins', '管理插件'),
				placeHolder: localize('studio.add.managePlugins.placeholder', '选择已添加的插件，或添加本机插件'),
				matchOnDescription: true,
			});
			if (pick?.plugin) {
				await openPlugin(pick.plugin);
			} else if (pick?.add) {
				await addLocalPlugin();
			} else if (widget.domNode.isConnected && widget.viewModel?.sessionResource.toString() === sessionResource?.toString()) {
				widget.focusInput();
			}
		},
	});
	return result;
}
