/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio - Conversation Memory
 *  Persists conversation history via IStorageService and manages
 *  context-window compaction (LLM summarization of early messages).
 *--------------------------------------------------------------------------------------------*/

import type { AIMessage } from './aiTypes.js';
import { countTokens } from './tokenCounter.js';

export interface ConversationTurn {
	userMessage: string;
	assistantMessage: string;
	requestId?: string;
	sourceUserMessage?: string;
	reasoningContent?: string;
	timestamp: number;
}

/** Native chat history owns visible text; enrich only unambiguous matches from the same chat archive. */
export function mergeArchivedReasoning(
	history: readonly Pick<ConversationTurn, 'userMessage' | 'assistantMessage' | 'requestId'>[],
	archived: readonly ConversationTurn[],
): Omit<ConversationTurn, 'timestamp'>[] {
	return history.map(({ userMessage, assistantMessage, requestId }) => {
		// Native response text includes tool progress and may differ from the final answer.
		// Never fall back to text if a supplied identity or its original user text changed.
		const matches = archived.filter(turn => requestId
			? turn.requestId === requestId && turn.sourceUserMessage === userMessage
			: turn.userMessage === userMessage && turn.assistantMessage === assistantMessage);
		const reasoningContent = matches[0]?.reasoningContent;
		// Exact native request identity also retains explicit attachment text. Edited
		// prompts and ambiguous archives must never inherit another turn's files.
		const archivedUserMessage = requestId && matches.length === 1 ? matches[0].userMessage : userMessage;
		return {
			userMessage: archivedUserMessage, assistantMessage,
			...(requestId ? { requestId, sourceUserMessage: userMessage } : {}),
			...(typeof reasoningContent === 'string' && matches.every(turn => turn.reasoningContent === reasoningContent) ? { reasoningContent } : {}),
		};
	});
}

export class ConversationMemory {
	private _turns: ConversationTurn[] = [];
	private _estimatedTokens = 0;

	get turns(): readonly ConversationTurn[] { return this._turns; }
	get estimatedTokens(): number { return this._estimatedTokens; }
	get messageCount(): number { return this._turns.length * 2; /* user + assistant */ }

	addTurn(userMsg: string, assistantMsg: string, reasoningContent?: string, source?: Pick<ConversationTurn, 'requestId' | 'sourceUserMessage'>): void {
		const turn = {
			userMessage: userMsg, assistantMessage: assistantMsg, timestamp: Date.now(),
			...(source?.requestId ? { requestId: source.requestId } : {}),
			...(typeof source?.sourceUserMessage === 'string' ? { sourceUserMessage: source.sourceUserMessage } : {}),
			...(typeof reasoningContent === 'string' ? { reasoningContent } : {}),
		};
		this._turns.push(turn);
		this._estimatedTokens += this._turnTokenCount(turn);
	}

	toMessages(): AIMessage[] {
		const msgs: AIMessage[] = [];
		for (const turn of this._turns) {
			msgs.push({ role: 'user', content: turn.userMessage });
			msgs.push({ role: 'assistant', content: turn.assistantMessage, ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}) });
		}
		return msgs;
	}

	/** @deprecated Use {@link compactWithSummarizer} instead */
	compactIfNeeded(maxTokens: number, threshold: number = 0.8): boolean {
		if (this._estimatedTokens < maxTokens * threshold || this._turns.length <= 2) { return false; }
		const compacted = this._turns.splice(0, this._turns.length - 2);
		const summary = this._buildSummary(compacted);
		this._turns.unshift({ userMessage: '[compacted]', assistantMessage: summary, timestamp: Date.now() });
		this._recalculateTokens();
		return true;
	}

	clear(): void { this._turns = []; this._estimatedTokens = 0; }

	/**
	 * Compact conversation history using an external summarizer (typically an LLM call).
	 * Keeps the 2 most recent turns intact; summarizes all older turns into a single
	 * synthetic turn. Returns true if compaction was performed.
	 */
	async compactWithSummarizer(
		summarizer: (turns: ConversationTurn[]) => Promise<string>,
		maxTokens: number,
		threshold: number = 0.8,
	): Promise<boolean> {
		if (this._estimatedTokens < maxTokens * threshold || this._turns.length <= 2) { return false; }

		const snapshot = this._turns.slice();
		const compacted = snapshot.slice(0, -2);
		if (!compacted.length) { return false; }

		const summary = await summarizer(compacted.map(({ userMessage, assistantMessage, timestamp }) => ({ userMessage, assistantMessage, timestamp })));
		// Awaiting a model must not delete history, including on cancellation or failure.
		// A concurrent clear/add also invalidates this candidate.
		if (!summary.trim() || this._turns.length !== snapshot.length || snapshot.some((turn, i) => this._turns[i] !== turn)) { return false; }
		if (this._tokenCount(summary) >= compacted.reduce((sum, turn) => sum + this._turnTokenCount(turn), 0)) { return false; }
		this._turns = [{
			userMessage: '[compacted]',
			assistantMessage: summary,
			timestamp: Date.now(),
		}, ...snapshot.slice(-2)];
		this._recalculateTokens();
		return true;
	}

	private _tokenCount(text: string): number {
		return countTokens(text);
	}

	private _turnTokenCount(turn: ConversationTurn): number {
		return this._tokenCount(turn.userMessage) + this._tokenCount(turn.assistantMessage) + this._tokenCount(turn.reasoningContent ?? '');
	}

	private _buildSummary(turns: ConversationTurn[]): string {
		const lines = turns.map(t =>
			'User: ' + t.userMessage.slice(0, 200) + '\nAssistant: ' + t.assistantMessage.slice(0, 200)
		);
		return '## Prior conversation (compressed)\n' + lines.join('\n\n');
	}

	private _recalculateTokens(): void {
		this._estimatedTokens = this._turns.reduce((sum, turn) => sum + this._turnTokenCount(turn), 0);
	}
}
