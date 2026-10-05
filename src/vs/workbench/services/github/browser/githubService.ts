/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { GitHubService, IGitHubService } from '../../../../platform/github/common/githubService.js';
import { IGitHubEndpointProvider, IGitHubTokenProvider } from '../../../../platform/github/common/githubTypes.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAuthenticationService } from '../../authentication/common/authentication.js';

interface IGitHubEndpoints {
	readonly apiBaseUri: string;
	readonly graphQlUri: string;
}

const GITHUB_DOT_COM_ENDPOINTS: IGitHubEndpoints = {
	apiBaseUri: 'https://api.github.com',
	graphQlUri: 'https://api.github.com/graphql',
};

/**
 * Derives GitHub REST and GraphQL endpoints from an optional GitHub Enterprise
 * base URI. Unset, empty, unparseable, and github.com hosts use the public API.
 * Enterprise Cloud (`.ghe.com`) uses an `api.` subdomain. Enterprise Server uses
 * `/api/v3` and `/api/graphql`.
 */
function deriveGitHubEndpoints(enterpriseUri: string | undefined): IGitHubEndpoints {
	if (!enterpriseUri) {
		return GITHUB_DOT_COM_ENDPOINTS;
	}

	let uri: URI;
	try {
		uri = URI.parse(enterpriseUri);
	} catch {
		return GITHUB_DOT_COM_ENDPOINTS;
	}

	const authority = uri.authority;
	if (!authority || authority === 'github.com' || authority === 'www.github.com' || authority === 'api.github.com') {
		return GITHUB_DOT_COM_ENDPOINTS;
	}

	const scheme = uri.scheme || 'https';
	const isCloud = /\.ghe\.com$/.test(authority);
	return {
		apiBaseUri: isCloud ? `${scheme}://api.${authority}` : `${scheme}://${authority}/api/v3`,
		graphQlUri: isCloud ? `${scheme}://api.${authority}/graphql` : `${scheme}://${authority}/api/graphql`,
	};
}

class WorkbenchGitHubEndpointProvider implements IGitHubEndpointProvider {

	readonly onDidChange: Event<void>;

	constructor(private readonly _defaultAccountService: IDefaultAccountService) {
		this.onDidChange = Event.map(_defaultAccountService.onDidChangeDefaultAccount, () => undefined);
	}

	getApiBaseUri(): string {
		return this._getEndpoints().apiBaseUri;
	}

	getGraphQlUri(): string {
		return this._getEndpoints().graphQlUri;
	}

	private _getEndpoints() {
		const authenticationProvider = this._defaultAccountService.getDefaultAccountAuthenticationProvider();
		const enterpriseUri = authenticationProvider.enterprise ? this._defaultAccountService.resolveGitHubUrl('') : undefined;
		return deriveGitHubEndpoints(enterpriseUri);
	}
}

class WorkbenchGitHubTokenProvider implements IGitHubTokenProvider {

	readonly onDidChangeToken: Event<void>;

	constructor(
		private readonly _authenticationService: IAuthenticationService,
		private readonly _defaultAccountService: IDefaultAccountService,
	) {
		this.onDidChangeToken = Event.any(
			Event.map(Event.filter(
				_authenticationService.onDidChangeSessions,
				event => event.providerId === _defaultAccountService.getDefaultAccountAuthenticationProvider().id,
			), () => undefined),
			Event.map(_defaultAccountService.onDidChangeDefaultAccount, () => undefined),
		);
	}

	async getToken(): Promise<string | undefined> {
		const provider = this._defaultAccountService.getDefaultAccountAuthenticationProvider();
		const defaultAccount = this._defaultAccountService.currentDefaultAccount ?? await this._defaultAccountService.getDefaultAccount();
		const sessions = await this._authenticationService.getSessions(provider.id, [], { silent: true }, true);
		const defaultSession = defaultAccount
			? sessions.find(session => session.id === defaultAccount.sessionId)
			: undefined;
		if (defaultAccount && !defaultSession) {
			return undefined;
		}
		if (defaultSession?.scopes.includes('repo')) {
			return defaultSession.accessToken;
		}
		const repositorySessions = await this._authenticationService.getSessions(provider.id, ['repo'], {
			createIfNone: true,
			...(defaultSession ? { account: defaultSession.account } : {}),
		}, true);
		return repositorySessions.find(session => !defaultSession || session.account.id === defaultSession.account.id)?.accessToken;
	}
}

export class WorkbenchGitHubService extends GitHubService {

	constructor(
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IDefaultAccountService defaultAccountService: IDefaultAccountService,
		@ILogService logService: ILogService,
	) {
		super({
			endpoint: new WorkbenchGitHubEndpointProvider(defaultAccountService),
			tokenProvider: new WorkbenchGitHubTokenProvider(authenticationService, defaultAccountService),
		}, logService);
	}
}

registerSingleton(IGitHubService, WorkbenchGitHubService, InstantiationType.Delayed);
