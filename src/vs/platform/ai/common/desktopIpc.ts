/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface AIStudioIpcRenderer {
	invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}

export interface AIStudioCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Access the optional bridge supplied by the desktop preload. */
export function getAIStudioIpcRenderer(): AIStudioIpcRenderer | undefined {
	return (globalThis as typeof globalThis & { vscode?: { ipcRenderer?: AIStudioIpcRenderer } }).vscode?.ipcRenderer;
}
