/*---------------------------------------------------------------------------------------------
 *  AI Studio — Byte Utilities
 *  Platform-agnostic conversion from raw SQLite BLOB to Float32Array.
 *  Handles Node.js Buffer, browser ArrayBuffer, and Uint8Array.
 *--------------------------------------------------------------------------------------------*/

/**
 * Convert a raw embedding value from SQLite BLOB storage into a Float32Array.
 * Supports Node.js Buffer (sqlite3), ArrayBuffer (better-sqlite3, browser),
 * and Uint8Array. Throws on unrecognized formats.
 */
export function bufferToFloat32Array(raw: unknown, dim: number): Float32Array {
	if (raw === null || raw === undefined) {
		throw new Error('Embedding data is null or undefined');
	}

	// Node.js sqlite3 returns Buffer (subclass of Uint8Array)
	if (Buffer.isBuffer(raw)) {
		if (raw.length === 0) throw new Error('Empty embedding buffer');
		return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
	}

	// Browser / Electron renderer — sqlite3 WASM returns ArrayBuffer
	if (raw instanceof ArrayBuffer) {
		if (raw.byteLength === 0) throw new Error('Empty embedding ArrayBuffer');
		return new Float32Array(raw);
	}

	// Uint8Array (e.g., from manual serialization)
	if (raw instanceof Uint8Array) {
		if (raw.length === 0) throw new Error('Empty embedding Uint8Array');
		return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
	}

	throw new Error(
		`Unsupported embedding storage format: ${typeof raw}. ` +
		`Expected Buffer, ArrayBuffer, or Uint8Array. ` +
		`The native sqlite3 module may not be installed correctly.`
	);
}
