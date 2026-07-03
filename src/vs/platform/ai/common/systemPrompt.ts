/*---------------------------------------------------------------------------------------------
 *  AI Studio — System Prompt
 *  Single source of truth for the AI coding assistant's base system prompt.
 *  Every provider and context builder references this.
 *--------------------------------------------------------------------------------------------*/

export const SYSTEM_PROMPT = 'You are an AI coding assistant in AI Studio. Use tools when needed. Be concise and thorough.';

export const COMPLETION_SYSTEM_PROMPT = (languageId: string, filePath: string): string =>
	`Complete code. Language: ${languageId}. File: ${filePath}. Output only the completion.`;
