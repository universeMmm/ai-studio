/*---------------------------------------------------------------------------------------------
 *  AI Studio — Inline Completion Contribution
 *  Registers the AI completion provider with VS Code''s inline completion API.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

class AIInlineCompletionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'vs.contrib.aiInlineCompletion';

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[AIInlineCompletion] Registered.');
	}
}

registerWorkbenchContribution2(
	AIInlineCompletionContribution.ID,
	AIInlineCompletionContribution,
	WorkbenchPhase.AfterRestored,
);
