/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { INTEGRITY_SIGN_IN_COMMAND_ID, integritySignInActionTitle, integritySignInComingSoonDetail, integritySignInComingSoonTitle, showIntegritySignInComingSoon } from '../../common/integritySignIn.js';

suite('Integrity sign-in placeholder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes Integrity-branded copy instead of GitHub Copilot', () => {
		const title = typeof integritySignInActionTitle === 'string' ? integritySignInActionTitle : integritySignInActionTitle.value;
		assert.strictEqual(INTEGRITY_SIGN_IN_COMMAND_ID, 'workbench.action.integrity.signIn');
		assert.strictEqual(title, 'Sign in to Integrity');
		assert.ok(!/GitHub Copilot/i.test(`${title}\n${integritySignInComingSoonTitle}\n${integritySignInComingSoonDetail}`));
	});

	test('shows a coming-soon dialog rather than GitHub OAuth', async () => {
		const dialogService = new TestDialogService();
		const prompts: Array<{ message: string; detail?: string }> = [];
		dialogService.info = async (message, detail) => {
			prompts.push({ message, detail });
		};

		await showIntegritySignInComingSoon(dialogService);

		assert.deepStrictEqual(prompts, [{
			message: integritySignInComingSoonTitle,
			detail: integritySignInComingSoonDetail,
		}]);
	});
});
