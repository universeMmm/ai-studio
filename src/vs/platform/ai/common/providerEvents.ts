/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI Studio — Read complete UTF-8 server-sent events from a provider.
 *--------------------------------------------------------------------------------------------*/

export async function* providerEvents(response: Response): AsyncGenerator<string> {
	if (!response.body) { throw new Error('Empty model response'); }
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let fields: string[] = [];
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop()!;
			for (const line of lines) {
				const field = line.replace(/\r$/, '');
				if (field.startsWith('data:')) { fields.push(field.slice(5).replace(/^ /, '')); }
				if (!field && fields.length) {
					yield fields.join('\n');
					fields = [];
				}
			}
			if (done) { break; }
		}
	} finally {
		void reader.cancel().catch(() => { });
		reader.releaseLock();
	}
}
