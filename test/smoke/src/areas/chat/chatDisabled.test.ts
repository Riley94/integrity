/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

export function setup(logger: Logger) {
	describe('Chat Disabled', () => {

		// Shared before/after handling
		installAllHandlers(logger);

		it('can disable AI features', async function () {
			const app = this.app as Application;

			await app.workbench.settingsEditor.addUserSetting('chat.disableAIFeatures', 'true');

			// await for setting to apply in the UI
			await app.code.waitForElements('.noauxiliarybar', true, elements => elements.length === 1);

			const commands = new Set<string>();
			for (const term of ['chat', 'agent', 'copilot', 'mcp']) {
				for (const command of await app.workbench.quickaccess.getVisibleCommandNames(term)) {
					commands.add(command);
				}
			}

			if (!commands.has('Chat: Use AI Features with Copilot for free...')) {
				throw new Error(`Expected AI related command not found`);
			}

			// Integrity registers many Chat/Agent commands in the workbench core, so
			// disabling AI cannot hide every Chat-named palette entry the way
			// uninstalling the Copilot extension can. Assert the primary chat
			// entry point gated on Setup.hidden is gone.
			if (commands.has('Chat: Open Chat')) {
				throw new Error('Expected "Chat: Open Chat" to be hidden after disabling AI features');
			}
		});
	});
}
