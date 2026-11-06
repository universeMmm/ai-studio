/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { getAICredentialTarget } from './aiSecurityConfiguration.js';

export interface DiscoveredModel {
	readonly id: string;
	readonly name?: string;
}

export interface ModelDiscoveryOptions {
	readonly endpoint: string;
	readonly apiType: string;
	readonly apiKey?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_PAGES = 20;

class ModelDiscoveryError extends Error { }

/** Fetch through the same Chromium session/system proxy as the model providers. */
export async function discoverModels(options: ModelDiscoveryOptions): Promise<readonly DiscoveredModel[]> {
	if (options.signal?.aborted) { throw new DOMException('Aborted', 'AbortError'); }
	let url: URL;
	try {
		getAICredentialTarget(options.apiType, options.endpoint.trim());
		url = new URL(options.endpoint.trim() || (options.apiType === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'));
		if (url.hash) { throw new Error(); }
	} catch {
		throw new ModelDiscoveryError(localize('studio.models.invalidEndpoint', '请输入有效的 HTTP(S) 服务地址，不要在地址中包含账号、密码或片段。'));
	}
	const path = url.pathname.replace(/\/+$/, '');
	if (!path.endsWith('/models')) {
		url.pathname = path + (options.apiType === 'anthropic' && !path.endsWith('/v1') ? '/v1/models' : '/models');
	} else {
		url.pathname = path;
	}
	const headers: Record<string, string> = { Accept: 'application/json' };
	const apiKey = options.apiKey?.trim();
	if (options.apiType === 'anthropic') {
		// Keep the existing provider's protocol version for compatible endpoints.
		headers['anthropic-version'] = '2023-06-01';
		if (apiKey) { headers['x-api-key'] = apiKey; }
		url.searchParams.set('limit', '1000');
	} else if (apiKey) {
		headers['Authorization'] = 'Bearer ' + apiKey;
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	options.signal?.addEventListener('abort', cancel, { once: true });
	let timedOut = false;
	const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	const models = new Map<string, DiscoveredModel>();
	const cursors = new Set<string>();
	const budget = { remaining: MAX_RESPONSE_BYTES };
	try {
		for (let page = 0; page < MAX_PAGES; page++) {
			controller.signal.throwIfAborted();
			// Do not follow server-provided links or redirects with credentials. All
			// pagination URLs are derived from the user-selected origin and path.
			const response = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
			if (!response.ok) {
				await response.body?.cancel();
				throw new ModelDiscoveryError(response.status === 401 || response.status === 403
					? localize('studio.models.authenticationFailed', '获取模型列表失败（HTTP {0}），请检查 API 密钥和访问权限。', response.status)
					: response.status === 404 || response.status === 405
						? localize('studio.models.notSupported', '服务未提供模型列表接口（HTTP {0}），可继续手动输入模型 ID。', response.status)
						: localize('studio.models.httpFailed', '获取模型列表失败（HTTP {0}），请稍后重试。', response.status));
			}
			const data = await readJson(response, controller.signal, budget);
			if (!isObject(data) || !Array.isArray(data.data)) { throw invalidResponse(); }
			let validRows = 0;
			for (const row of data.data) {
				if (!isObject(row) || !validString(row.id)) { continue; }
				validRows++;
				const id = row.id.trim();
				const name = validString(row.display_name) ? row.display_name.trim() : validString(row.name) ? row.name.trim() : undefined;
				if (!models.has(id)) { models.set(id, { id, ...(name && name !== id ? { name } : {}) }); }
				if (models.size > MAX_MODELS) { throw responseTooLarge(); }
			}
			if (data.data.length && !validRows) { throw invalidResponse(); }
			controller.signal.throwIfAborted();
			if (options.apiType !== 'anthropic' || data.has_more !== true) { return [...models.values()]; }
			if (!validRows || !validString(data.last_id) || cursors.has(data.last_id)) { throw invalidResponse(); }
			cursors.add(data.last_id);
			url.searchParams.set('after_id', data.last_id);
			url.searchParams.delete('before_id');
		}
		throw responseTooLarge();
	} catch (error) {
		if (options.signal?.aborted) { throw new DOMException('Aborted', 'AbortError'); }
		if (timedOut) { throw new ModelDiscoveryError(localize('studio.models.timeout', '获取模型列表超时，请检查服务地址或系统代理后重试。')); }
		if (error instanceof ModelDiscoveryError) { throw error; }
		// Provider errors can echo request headers. Never display their body or the
		// raw transport error, which may contain secrets from the configured URL.
		throw new ModelDiscoveryError(localize('studio.models.networkError', '无法获取模型列表，请检查服务地址、网络和系统代理。为保护密钥，模型列表请求不接受重定向。'));
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', cancel);
		controller.abort();
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
}

function invalidResponse(): ModelDiscoveryError {
	return new ModelDiscoveryError(localize('studio.models.invalidResponse', '服务返回的模型列表格式无效，可继续手动输入模型 ID。'));
}

function responseTooLarge(): ModelDiscoveryError {
	return new ModelDiscoveryError(localize('studio.models.responseTooLarge', '服务返回的模型列表过大，可继续手动输入模型 ID。'));
}

async function readJson(response: Response, signal: AbortSignal, budget: { remaining: number }): Promise<unknown> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > budget.remaining) {
		await response.body?.cancel();
		throw responseTooLarge();
	}
	if (!response.body) { throw invalidResponse(); }
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) { break; }
			budget.remaining -= value.byteLength;
			if (budget.remaining < 0) { throw responseTooLarge(); }
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		signal.throwIfAborted();
		try { return JSON.parse(chunks.join('')); } catch { throw invalidResponse(); }
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
