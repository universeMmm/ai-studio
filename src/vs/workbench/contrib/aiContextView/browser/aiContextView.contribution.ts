/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Session inspector in the secondary sidebar.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { AIContextView, type InspectorTab } from './aiContextView.js';

const id = 'workbench.view.aiStudio.inspector';
const title = localize2('aiStudio.inspector', '任务详情');
const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id, title, icon: Codicon.layoutSidebarRight, storageId: id, order: 0, hideIfEmpty: true,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [id, { mergeViewWithContainerWhenSingleView: true }])
}, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: AIContextView.ID, name: title, containerIcon: container.icon, singleViewPaneContainerTitle: title.value,
	ctorDescriptor: new SyncDescriptor(AIContextView), canToggleVisibility: false, canMoveView: true,
}], container);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'aiStudio.openInspector', title: localize2('aiStudio.openInspector', '打开任务详情'), f1: true });
	}
	override async run(accessor: ServicesAccessor, tab?: InspectorTab): Promise<void> {
		const pane = await accessor.get(IViewsService).openView<AIContextView>(AIContextView.ID, false);
		if (tab === 'changes' || tab === 'activity' || tab === 'context') { pane?.selectTab(tab); }
		pane?.focus();
	}
});
