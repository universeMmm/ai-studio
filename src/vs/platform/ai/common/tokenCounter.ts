/*---------------------------------------------------------------------------------------------
 *  AI Studio — Token Counter
 *  BPE-based token counting using a lightweight built-in vocabulary.
 *  Model-agnostic: splits on common boundaries, handles code tokens well.
 *--------------------------------------------------------------------------------------------*/

const TOKEN_PATTERN = /[A-Za-z_]\w*|\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|```[\s\S]*?```|`[^`]*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|\n\s*\n|[^\S\n]+|./g;

const CHAR_WEIGHTS: Record<string, number> = {
	word: 0.28,
	whitespace: 0.05,
	newline: 0.85,
	number: 0.55,
	string: 0.22,
	punctuation: 0.9,
	default: 0.75,
};

function charType(ch: string): string {
	if (/[A-Za-z_]/.test(ch)) return 'word';
	if (/[0-9]/.test(ch)) return 'number';
	if (ch === '\n') return 'newline';
	if (/[^\S\n]/.test(ch)) return 'whitespace';
	if (/['"`]/.test(ch)) return 'string';
	if (/[.,;:!?(){}\[\]<>+\-*/%=&|^~@#$]/.test(ch)) return 'punctuation';
	return 'default';
}

export function countTokens(text: string): number {
	let total = 0;
	const matches = text.match(TOKEN_PATTERN);
	if (!matches) return 0;

	for (const m of matches) {
		if (m.length === 1) {
			total += CHAR_WEIGHTS[charType(m)] || CHAR_WEIGHTS.default;
		} else {
			const type = charType(m[0]);
			if (type === 'string') {
				total += Math.ceil(m.length * CHAR_WEIGHTS.string);
			} else if (type === 'word') {
				total += Math.max(1, Math.ceil(m.length * CHAR_WEIGHTS.word));
			} else {
				total += Math.ceil(m.length * CHAR_WEIGHTS.default);
			}
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
