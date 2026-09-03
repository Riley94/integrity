/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Integrity Git branding', () => {
	test('source control empty states say Integrity instead of VS Code', () => {
		const nlsPath = path.join(__dirname, '..', '..', 'package.nls.json');
		const nls = JSON.parse(fs.readFileSync(nlsPath, 'utf8')) as Record<string, string | { message: string }>;

		const messages = Object.values(nls).map(value => typeof value === 'string' ? value : value.message);
		const learnMore = messages.filter(message => message.includes('To learn more about how to use Git and source control'));

		assert.ok(learnMore.length > 0);
		for (const message of learnMore) {
			assert.ok(message.includes('source control in Integrity'), message);
			assert.ok(!message.includes('source control in VS Code'), message);
		}

		assert.strictEqual(
			nls['view.workbench.learnMore'],
			'To learn more about how to use Git and source control in Integrity [read our docs](https://aka.ms/vscode-scm).'
		);
	});
});
