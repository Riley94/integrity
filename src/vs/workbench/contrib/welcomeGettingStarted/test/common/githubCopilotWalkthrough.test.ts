/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isGitHubCopilotWalkthroughExtension } from '../../common/githubCopilotWalkthrough.js';

suite('GitHub Copilot walkthrough filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hides GitHub Copilot walkthrough extensions', () => {
		assert.deepStrictEqual({
			copilotChat: isGitHubCopilotWalkthroughExtension('GitHub.copilot-chat'),
			copilot: isGitHubCopilotWalkthroughExtension('github.copilot'),
			integrityAi: isGitHubCopilotWalkthroughExtension('integrity.integrity-ai'),
			git: isGitHubCopilotWalkthroughExtension('vscode.git'),
		}, {
			copilotChat: true,
			copilot: true,
			integrityAi: false,
			git: false,
		});
	});
});
