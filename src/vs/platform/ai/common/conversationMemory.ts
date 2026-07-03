/*---------------------------------------------------------------------------------------------
 *  AI Studio - Conversation Memory
 *  Persists conversation history via IStorageService and manages
 *  context-window compaction (LLM summarization of early messages).
 *--------------------------------------------------------------------------------------------*/

import type { AIMessage } from "./aiTypes.js";
import { countTokens } from "./tokenCounter.js";

export interface ConversationTurn {
	userMessage: string;
	assistantMessage: string;
	timestamp: number;
}

export class ConversationMemory {
	private _turns: ConversationTurn[] = [];
	private _estimatedTokens = 0;

	get turns(): readonly ConversationTurn[] { return this._turns; }
	get estimatedTokens(): number { return this._estimatedTokens; }
	get messageCount(): number { return this._turns.length * 2; /* user + assistant */ }

	addTurn(userMsg: string, assistantMsg: string): void {
		this._turns.push({ userMessage: userMsg, assistantMessage: assistantMsg, timestamp: Date.now() });
		this._estimatedTokens += this._tokenCount(userMsg) + this._tokenCount(assistantMsg);
	}

	toMessages(): AIMessage[] {
		const msgs: AIMessage[] = [];
		for (const turn of this._turns) {
			msgs.push({ role: "user", content: turn.userMessage });
			msgs.push({ role: "assistant", content: turn.assistantMessage });
		}
		return msgs;
	}

	/** @deprecated Use {@link compactWithSummarizer} instead */
	compactIfNeeded(maxTokens: number, threshold: number = 0.8): boolean {
		if (this._estimatedTokens < maxTokens * threshold || this._turns.length <= 2) return false;
		const compacted = this._turns.splice(0, this._turns.length - 2);
		const summary = this._buildSummary(compacted);
		this._turns.unshift({ userMessage: "[compacted]", assistantMessage: summary, timestamp: Date.now() });
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
		if (this._estimatedTokens < maxTokens * threshold || this._turns.length <= 2) return false;

		const compacted = this._turns.splice(0, this._turns.length - 2);
		if (!compacted.length) return false;

		const summary = await summarizer(compacted);
		this._turns.unshift({
			userMessage: '[compacted]',
			assistantMessage: summary,
			timestamp: Date.now(),
		});
		this._recalculateTokens();
		return true;
	}

	private _tokenCount(text: string): number {
		return countTokens(text);
	}

	private _buildSummary(turns: ConversationTurn[]): string {
		const lines = turns.map(t =>
			"User: " + t.userMessage.slice(0, 200) + "\nAssistant: " + t.assistantMessage.slice(0, 200)
		);
		return "## Prior conversation (compressed)\n" + lines.join("\n\n");
	}

	private _recalculateTokens(): void {
		this._estimatedTokens = this._turns.reduce((sum, t) =>
			sum + this._tokenCount(t.userMessage) + this._tokenCount(t.assistantMessage), 0);
	}
}
