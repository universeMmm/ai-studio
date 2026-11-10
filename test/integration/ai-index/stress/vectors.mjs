/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dense deterministic vectors: every file owns its buffer. No shared arrays, zero-padding,
// external model calls or dimensionality reduction can hide the real memory/CPU cost.
export function vectorFor(id, dimensions) {
	let state = (id + 1) >>> 0;
	const vector = new Float32Array(dimensions);
	for (let i = 0; i < dimensions; i++) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		vector[i] = (state >>> 0) / 0xffffffff - 0.5;
	}
	return vector;
}
export function recordFor(id, dimensions, root = '/workspace') {
	const file = `${root}/group-${String(Math.floor(id / 1000)).padStart(3, '0')}/file-${String(id).padStart(6, '0')}.ts`;
	return { file, entries: [{ chunk: { id: file + ':1', filePath: file, startLine: 1, endLine: 3, content: `export function value${id}() {\n  return ${id};\n}`, kind: 'function', name: `value${id}` }, embedding: vectorFor(id, dimensions) }], metadata: { mtime: 1, size: 50, hash: String(id), embeddingKey: 'stress' } };
}
export function percentile(values, quantile) { return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]; }
