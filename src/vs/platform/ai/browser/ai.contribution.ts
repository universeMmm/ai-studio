/*---------------------------------------------------------------------------------------------
 *  AI Studio — Workbench Contribution Entry Point
 *  Registers AI configuration and services into the VS Code DI container.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../platform/registry/common/platform.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../../platform/configuration/common/configurationRegistry.js';
import { aiConfigurationNode } from '../common/aiConfiguration.js';
import { IAIModelService, AIModelService } from './aiModelService.js';
import { IAIAgentService, AIAgentService } from './aiAgentService.js';
import { IAICompletionService, AICompletionService } from './aiCompletionService.js';
import { IAIContextService, AIContextService } from './aiContextService.js';
import { IAIIndexService, AIIndexService } from './aiIndexService.js';
import { IAIKeychainService, AIKeychainService } from './credentialService.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';

// ── Configuration ──────────────────────────────────────────────
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration(aiConfigurationNode);

// ── AI Services (lazy instantiation) ────────────────────────────
registerSingleton(IAIModelService, AIModelService, InstantiationType.Delayed);
registerSingleton(IAIAgentService, AIAgentService, InstantiationType.Delayed);
registerSingleton(IAICompletionService, AICompletionService, InstantiationType.Delayed);
registerSingleton(IAIContextService, AIContextService, InstantiationType.Delayed);
registerSingleton(IAIIndexService, AIIndexService, InstantiationType.Delayed);
registerSingleton(IAIKeychainService, AIKeychainService, InstantiationType.Delayed);
