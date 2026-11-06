/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Token Counter
 *  Lightweight estimate for context compaction when provider usage is unavailable.
 *--------------------------------------------------------------------------------------------*/

// A leading space is commonly encoded with the following word or symbol.
// Keep comments and string literals tokenized like the text they contain.
const TOKEN_PIECES = / ?[A-Za-z_]\w*| ?[0-9]+| ?[\p{P}\p{S}]+|\r\n|[\r\n]|[^\S\r\n]+|./gu;

export function countTokens(text: string): number {
	let total = 0;
	for (const [piece] of text.matchAll(TOKEN_PIECES)) {
		const content = piece.trimStart();
		if (!content) {
			total += Math.ceil(piece.length / 8);
		} else if (/^[A-Za-z_]/.test(content)) {
			total += Math.max(1, content.length / 5);
		} else if (/^[0-9]/.test(content)) {
			total += Math.ceil(content.length / 3);
		} else {
			total += Math.ceil(content.length / 2);
		}
	}
	return Math.ceil(total);
}

export function countMessageTokens(messages: Array<{ role: string; content: string | unknown }>): number {
	let total = 0;
	for (const msg of messages) {
		total += 4;
		if (typeof msg.content === 'string') {
			total += countTokens(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of (Array.isArray(msg.content) ? msg.content : [])) {
				if (block.type === 'text' && typeof block.text === 'string') {
					total += countTokens(block.text);
				}
			}
		}
	}
	return total;
}
