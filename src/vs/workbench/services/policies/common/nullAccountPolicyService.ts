/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, IPolicyService, PolicyDefinition } from '../../../../platform/policy/common/policy.js';
import { AccountPolicyGateState, IAccountPolicyGateInfo, IAccountPolicyGateService } from './accountPolicyService.js';

/**
 * Null implementation of AccountPolicyService that always returns Inactive,
 * meaning no account-based policy restrictions are ever applied.
 */
export class NullAccountPolicyService extends AbstractPolicyService implements IPolicyService, IAccountPolicyGateService {

	declare readonly _serviceBrand: undefined;

	private _gateInfo: IAccountPolicyGateInfo = { state: AccountPolicyGateState.Inactive };
	get gateInfo(): IAccountPolicyGateInfo { return this._gateInfo; }

	private readonly _onDidChangeGateInfo = this._register(new Emitter<IAccountPolicyGateInfo>());
	readonly onDidChangeGateInfo: Event<IAccountPolicyGateInfo> = this._onDidChangeGateInfo.event;

	constructor(
		@ILogService logService: ILogService,
	) {
		super();
		this._register({ dispose: () => { } });
	}

	protected async _updatePolicyDefinitions(_policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<void> {
		// No-op: never apply any account-based policy restrictions
	}
}
