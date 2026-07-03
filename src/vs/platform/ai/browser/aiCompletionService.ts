/*---------------------------------------------------------------------------------------------
 *  AI Studio — Completion Service
 *  Manages inline code completion with debounce + FIM prompting + cancellation.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IAIModelService } from './aiModelService.js';
import type { AICompletionCallbacks, FileContext } from '../common/aiTypes.js';

export const IAICompletionService = createDecorator<IAICompletionService>('aiCompletionService');

export interface IAICompletionService {
	readonly _serviceBrand: undefined;
	provideInlineCompletion(prefix: string, suffix: string, fileContext: FileContext): Promise<{ text: string } | null>;
	cancelCurrentCompletion(): void;
}

export class AICompletionService extends Disposable implements IAICompletionService {
	declare readonly _serviceBrand: undefined;

	private _pendingController: AbortController | null = null;

	constructor(
		@IAIModelService private readonly aiModelService: IAIModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) { super(); }

	async provideInlineCompletion(prefix: string, suffix: string, fileContext: FileContext): Promise<{ text: string } | null> {
		if (!this.configurationService.getValue<boolean>('ai.completion.enabled')) { return null; }

		// Cancel any in-flight request — only the latest keystroke matters
		this.cancelCurrentCompletion();
		this._pendingController = new AbortController();
		const controller = this._pendingController;
		const signal = controller.signal;

		const delay = this.configurationService.getValue<number>('ai.completion.delay') || 150;

		// Pre-fetch neighbor context in parallel with the debounce delay
		const ctxPromise = this._buildNeighborContext(fileContext);

		if (delay > 0) {
			await new Promise<void>(resolve => {
				const t = setTimeout(resolve, delay);
				signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
			});
			if (signal.aborted) return null;
		}

		const neighborCtx = await ctxPromise;

		return new Promise(resolve => {
			let result = '';
			const cb: AICompletionCallbacks = {
				onToken: (t) => { result += t; },
				onDone: () => { this._pendingController = null; resolve(result ? { text: result } : null); },
				onError: (err) => { this._pendingController = null; this.logService.error('[AICompletion]', err); resolve(null); },
			};

			signal.addEventListener('abort', () => { this._pendingController = null; resolve(null); });

			const stopSeqs = ['\n\n', '\n// ', '\n/*', '\nfunction ', '\nclass ', '\nexport ', '\nimport ', '\nconst ', '\nlet ', '\nvar '];
			const abortCtrl = this.aiModelService.streamCompletion(neighborCtx + prefix, suffix, fileContext, { maxTokens: 4096, temperature: 0, stopSequences: stopSeqs }, cb);
			signal.addEventListener('abort', () => abortCtrl.abort());
		});
	}

	private async _buildNeighborContext(fc: FileContext): Promise<string> {
		try {
			const dir = fc.filePath.substring(0, fc.filePath.lastIndexOf('/'));
			if (!dir) return '';
			const siblings = await this._listSiblings(dir);
			const relevant = siblings.filter(s => this._sameExt(s, fc.filePath)).slice(0, 3);
			let ctx = '';
			for (const sib of relevant) {
				try {
					const uri = URI.file(sib);
					const content = (await this.fileService.readFile(uri)).value.toString();
					ctx += `\n// --- ${sib.split('/').pop()} ---\n${content.slice(0, 2000)}\n`;
				} catch { /* skip unreadable files */ }
			}
			return ctx;
		} catch { return ''; }
	}

	private async _listSiblings(dir: string): Promise<string[]> {
		try {
			const stat = await this.fileService.resolve(URI.file(dir));
			return (stat.children || []).map((c: any) => dir + '/' + c.name);
		} catch { return []; }
	}

	private _sameExt(a: string, b: string): boolean {
		const ea = a.split('.').pop();
		const eb = b.split('.').pop();
		return ea === eb;
	}

	cancelCurrentCompletion(): void { this._pendingController?.abort(); this._pendingController = null; }
}
