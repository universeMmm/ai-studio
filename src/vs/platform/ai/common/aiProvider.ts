/*---------------------------------------------------------------------------------------------
 *  AI Studio — LLM Provider Interface
 *  Abstraction over OpenAI / Anthropic / custom API backends.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import {
	AIMessage,
	AITool,
	AIRequestOptions,
	AIStreamCallbacks,
	AICompletionOptions,
	AICompletionCallbacks,
	FileContext,
	AIModel,
} from './aiTypes.js';

export const IAIProvider = createDecorator<IAIProvider>('aiProvider');

/**
 * Unified LLM provider interface.
 * Every backend (OpenAI, Anthropic, custom) implements this.
 */
export interface IAIProvider {
	readonly _serviceBrand: undefined;

	/** Unique provider identifier, e.g. "openai" or "anthropic". */
	readonly id: string;

	/** Human-readable label. */
	readonly label: string;

	/**
	 * Streaming chat: send messages + tool definitions, receive tokens
	 * and tool-use events through callbacks.
	 * @returns AbortController so the caller can cancel the request.
	 */
	streamChat(
		messages: AIMessage[],
		tools: AITool[],
		options: AIRequestOptions,
		callbacks: AIStreamCallbacks
	): AbortController;

	/**
	 * Streaming code completion (Fill-in-the-Middle).
	 * Latency-sensitive — target < 300ms first token.
	 */
	streamCompletion(
		prefix: string,
		suffix: string,
		fileContext: FileContext,
		options: AICompletionOptions,
		callbacks: AICompletionCallbacks
	): AbortController;

	/**
	 * Generate embeddings for the given texts.
	 * Used by the codebase index.
	 */
	embed(texts: string[]): Promise<number[][]>;

	/**
	 * List available models for this provider.
	 */
	listModels(): Promise<AIModel[]>;

	/** Dispose the provider and release any resources. */
	dispose(): void;
}
