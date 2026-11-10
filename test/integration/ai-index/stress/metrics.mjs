/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import os from 'node:os';

export const environment = () => ({
	platform: process.platform, arch: process.arch, node: process.version,
	electron: process.versions.electron ?? null, modules: process.versions.modules,
	memoryBytes: os.totalmem(), cpus: os.availableParallelism(),
	commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
	runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, stressRunId: process.env.INDEX_STRESS_RUN_ID ?? null,
});
export const memory = () => ({ ...process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS * 1024 });
export const collect = async () => {
	for (let i = 0; i < 4; i++) { globalThis.gc?.(); await new Promise(resolve => setTimeout(resolve, 25)); }
};
