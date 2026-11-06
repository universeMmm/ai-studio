/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPayloadData, IXHROverride } from '@microsoft/1ds-post-js';
import { streamToBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IRequestService, NO_FETCH_TELEMETRY } from '../../request/common/request.js';
import { AbstractOneDataSystemAppender, IAppInsightsCore } from '../common/1dsAppender.js';

type OnCompleteFunc = (status: number, headers: { [headerName: string]: string }, response?: string) => void;

interface IResponseData {
	headers: { [headerName: string]: string };
	statusCode: number;
	responseData: string;
}

/**
 * Completes a request to submit telemetry to the server utilizing the request service
 * @param options The options which will be used to make the request
 * @param requestService The request service
 * @returns An object containing the headers, statusCode, and responseData
 */
async function makeTelemetryRequest(options: IRequestOptions, requestService: IRequestService): Promise<IResponseData> {
	const response = await requestService.request(options, CancellationToken.None);
	const responseData = (await streamToBuffer(response.stream)).toString();
	const statusCode = response.res.statusCode ?? 200;
	const headers = response.res.headers as Record<string, string>;
	return {
		headers,
		statusCode,
		responseData
	};
}

async function sendPostAsync(requestService: IRequestService, payload: IPayloadData, oncomplete: OnCompleteFunc) {
	const telemetryRequestData = typeof payload.data === 'string' ? payload.data : new TextDecoder().decode(payload.data);
	const requestOptions: IRequestOptions = {
		type: 'POST',
		headers: {
			...payload.headers,
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(payload.data).toString()
		},
		url: payload.urlString,
		data: telemetryRequestData,
		callSite: NO_FETCH_TELEMETRY
	};

	try {
		const responseData = await makeTelemetryRequest(requestOptions, requestService);
		oncomplete(responseData.statusCode, responseData.headers, responseData.responseData);
	} catch {
		// If it errors out, send status of 0 and a blank response to oncomplete so we can retry events
		oncomplete(0, {});
	}
}


export class OneDataSystemAppender extends AbstractOneDataSystemAppender {

	constructor(
		requestService: IRequestService,
		isInternalTelemetry: boolean,
		eventPrefix: string,
		defaultData: { [key: string]: unknown } | null,
		iKeyOrClientFactory: string | (() => IAppInsightsCore), // allow factory function for testing
	) {
		// Override the way events get sent since node doesn't have XHTMLRequest
		const customHttpXHROverride: IXHROverride = {
			sendPOST: (payload: IPayloadData, oncomplete: OnCompleteFunc) => {
				// Fire off the async request without awaiting it
				sendPostAsync(requestService, payload, oncomplete);
			}
		};

		super(isInternalTelemetry, eventPrefix, defaultData, iKeyOrClientFactory, customHttpXHROverride);
	}
}
