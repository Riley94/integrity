/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { getDefaultChatConfig, getNonEnterpriseCopilotUsersContext } from '../../browser/actions/chatActions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

suite('ChatActions provider config', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Ollama-only product config leaves enterprise undefined', () => {
		const config = getDefaultChatConfig({
			provider: {
				default: { id: 'ollama', name: 'Ollama' },
			},
			completionsAdvancedSetting: 'integrity.ai.inlineCompletions.advanced',
			completionsMenuCommand: '',
		});

		assert.deepStrictEqual(config, {
			provider: {
				default: { id: 'ollama', name: 'Ollama' },
				enterprise: undefined,
			},
			completionsAdvancedSetting: 'integrity.ai.inlineCompletions.advanced',
			completionsMenuCommand: '',
		});
	});

	test('missing enterprise does not throw when building the non-enterprise context', () => {
		const config = getDefaultChatConfig({
			provider: {
				default: { id: 'ollama', name: 'Ollama' },
			},
		});

		assert.strictEqual(config.provider.enterprise, undefined);
		assert.strictEqual(
			getNonEnterpriseCopilotUsersContext(config).serialize(),
			ChatContextKeys.enabled.serialize()
		);
	});

	test('configured enterprise still excludes that auth provider', () => {
		const config = getDefaultChatConfig({
			provider: {
				default: { id: 'github', name: 'GitHub' },
				enterprise: { id: 'github-enterprise', name: 'GitHub Enterprise' },
			},
			completionsAdvancedSetting: 'github.copilot.advanced',
		});

		assert.strictEqual(
			getNonEnterpriseCopilotUsersContext(config).serialize(),
			ContextKeyExpr.and(
				ChatContextKeys.enabled,
				ContextKeyExpr.notEquals('config.github.copilot.advanced.authProvider', 'github-enterprise')
			)!.serialize()
		);
	});
});
