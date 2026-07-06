/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IDefaultAccountAuthenticationProvider, IDefaultAccount, IPolicyData, ICopilotTokenInfo } from '../../../../base/common/defaultAccount.js';
import { IDefaultAccountProvider, IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';

export class NullDefaultAccountProvider implements IDefaultAccountProvider {

	private readonly _onDidChangeDefaultAccount = new Emitter<IDefaultAccount | null>();
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	private readonly _onDidChangePolicyData = new Emitter<IPolicyData | null>();
	readonly onDidChangePolicyData = this._onDidChangePolicyData.event;

	private readonly _onDidChangeCopilotTokenInfo = new Emitter<ICopilotTokenInfo | null>();
	readonly onDidChangeCopilotTokenInfo = this._onDidChangeCopilotTokenInfo.event;

	readonly defaultAccount: IDefaultAccount | null = null;
	readonly policyData: IPolicyData | null = null;
	readonly copilotTokenInfo: ICopilotTokenInfo | null = null;

	private readonly noopAuthProvider: IDefaultAccountAuthenticationProvider = {
		id: 'none',
		name: 'None',
		enterprise: false,
	};

	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider {
		return this.noopAuthProvider;
	}

	resolveGitHubUrl(path: string): string {
		return `https://github.com/${path}`;
	}

	async refresh(_options?: { forceRefresh?: boolean }): Promise<IDefaultAccount | null> {
		return null;
	}

	async signIn(_options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null> {
		return null;
	}

	async signOut(): Promise<void> {
		// no-op
	}
}

export class NullDefaultAccountService extends Disposable implements IDefaultAccountService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDefaultAccount = this._register(new Emitter<IDefaultAccount | null>());
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	private readonly _onDidChangePolicyData = this._register(new Emitter<IPolicyData | null>());
	readonly onDidChangePolicyData = this._onDidChangePolicyData.event;

	private readonly _onDidChangeCopilotTokenInfo = this._register(new Emitter<ICopilotTokenInfo | null>());
	readonly onDidChangeCopilotTokenInfo = this._onDidChangeCopilotTokenInfo.event;

	readonly policyData: IPolicyData | null = null;
	readonly currentDefaultAccount: IDefaultAccount | null = null;
	readonly copilotTokenInfo: ICopilotTokenInfo | null = null;

	private readonly noopAuthProvider: IDefaultAccountAuthenticationProvider = {
		id: 'none',
		name: 'None',
		enterprise: false,
	};

	async getDefaultAccount(): Promise<IDefaultAccount | null> {
		return null;
	}

	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider {
		return this.noopAuthProvider;
	}

	setDefaultAccountProvider(_provider: IDefaultAccountProvider): void {
		// no-op
	}

	async refresh(_options?: { forceRefresh?: boolean }): Promise<IDefaultAccount | null> {
		return null;
	}

	async signIn(_options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null> {
		return null;
	}

	async signOut(): Promise<void> {
		// no-op
	}

	resolveGitHubUrl(path: string): string {
		return `https://github.com/${path}`;
	}
}
