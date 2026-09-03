/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import product from '../../../../../platform/product/common/product.js';
import { walkthroughs } from '../../common/gettingStartedContent.js';

suite('Integrity getting started walkthroughs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Setup walkthrough uses Integrity branding and local AI setup', () => {
		const setup = walkthroughs.find(walkthrough => walkthrough.id === 'Setup');
		assert.ok(setup);
		assert.strictEqual(setup.title, `Get started with ${product.nameShort}`);
		assert.strictEqual(setup.walkthroughPageTitle, `Setup ${product.nameShort}`);

		const stepIds = setup.content.steps.map(step => step.id);
		assert.deepStrictEqual(stepIds, ['integrityAiSetup', 'pickColorTheme', 'videoTutorial']);

		const integrityAi = setup.content.steps.find(step => step.id === 'integrityAiSetup');
		assert.ok(integrityAi);
		assert.strictEqual(integrityAi.title, 'Use AI features with Integrity');
		assert.ok(integrityAi.description.includes('command:integrity.ai.setupModels'));
		assert.ok(integrityAi.description.includes('command:integrity.ai.openChat'));
		assert.ok(!/Copilot|VS Code/i.test(`${setup.title}\n${setup.walkthroughPageTitle}\n${integrityAi.title}\n${integrityAi.description}`));
	});

	test('does not contribute Copilot or VS Code getting-started titles', () => {
		for (const walkthrough of walkthroughs) {
			assert.ok(!/GitHub Copilot|Get started with VS Code/i.test(walkthrough.title), walkthrough.id);
			assert.ok(!setupMentionsCopilot(walkthrough.content.steps.map(step => step.title).join('\n')), walkthrough.id);
		}
	});
});

function setupMentionsCopilot(text: string): boolean {
	return /GitHub Copilot|Use AI features with Copilot/i.test(text);
}
