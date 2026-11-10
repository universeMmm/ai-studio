/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { getUserAIConfiguration } from '../common/aiSecurityConfiguration.js';
import { SENSITIVE_FILE_GLOBS } from '../common/sensitiveFiles.js';

export interface IndexOptions {
	maxFiles: number;
	maxMemoryMB: number;
	batchSize: number;
	requestInterval: number;
	include: string[];
	exclude: string[];
	embeddingKey: string;
}

export function getIndexOptions(configuration: IConfigurationService, root: string): IndexOptions {
	const resource = URI.file(root);
	const number = (key: string, fallback: number, min: number, max: number) => {
		const value = configuration.getValue<number>(key, { resource });
		return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
	};
	const patterns = (key: string, fallback: string[]) => {
		const value = configuration.getValue<unknown>(key, { resource });
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : fallback;
	};
	const exclude = ['**/node_modules/**', '**/.ai-studio/**', ...SENSITIVE_FILE_GLOBS.map(pattern => `**/${pattern}/**`), ...SENSITIVE_FILE_GLOBS.map(pattern => `**/${pattern}`)];
	for (const key of ['files.exclude', 'search.exclude']) {
		const entries = configuration.getValue<Record<string, unknown>>(key, { resource }) ?? {};
		// Sibling-dependent clauses require the search service's sibling resolver; only unconditional exclusions apply here.
		for (const [pattern, value] of Object.entries(entries)) { if (value === true) { exclude.push(pattern, pattern + '/**'); } }
	}
	exclude.push(...patterns('ai.index.exclude', []));
	return {
		maxFiles: number('ai.index.maxFiles', 10000, 1, 100000),
		maxMemoryMB: number('ai.index.maxMemoryMB', 256, 16, 4096),
		batchSize: number('ai.index.batchSize', 16, 1, 128),
		requestInterval: number('ai.index.requestInterval', 200, 0, 60000),
		include: patterns('ai.index.include', ['**/*']), exclude,
		// Changing the endpoint/provider invalidates old vectors, even when their dimensions happen to match.
		embeddingKey: JSON.stringify(['chunks-v2', getUserAIConfiguration(configuration, 'ai.apiType', 'openai'), getUserAIConfiguration(configuration, 'ai.apiBase', ''), 'text-embedding-3-small']),
	};
}
