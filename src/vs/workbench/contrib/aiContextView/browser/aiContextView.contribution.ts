/*---------------------------------------------------------------------------------------------
 *  AI Studio - AI Context View Contribution
 *  Registers the AI Context sidebar view into the explorer container
 *  and wires the DI service registration.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from "../../../../platform/registry/common/platform.js";
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from "../../../common/contributions.js";
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions } from "../../../common/views.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { AIContextView } from "./aiContextView.js";
import { IAIAgentService } from "../../../../platform/ai/browser/aiAgentService.js";
import { IAIContextService } from "../../../../platform/ai/browser/aiContextService.js";
import { IAIIndexService } from "../../../../platform/ai/browser/aiIndexService.js";

class AIContextViewContribution implements IWorkbenchContribution {
	static readonly ID = "vs.contrib.aiContextView";

	constructor() {
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		viewsRegistry.registerViews([{
			id: "ai-studio.context",
			name: { value: "AI Context", original: "AI Context" },
			ctorDescriptor: new SyncDescriptor(AIContextView, [IAIAgentService, IAIContextService, IAIIndexService]),
			canToggleVisibility: true,
			hideByDefault: false,
			order: 10,
		}], Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).get("explorer")!);
	}
}

registerWorkbenchContribution2(AIContextViewContribution.ID, AIContextViewContribution, WorkbenchPhase.AfterRestored);
