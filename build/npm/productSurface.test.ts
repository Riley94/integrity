/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

const repoRoot = path.join(import.meta.dirname, '..', '..');

const REMOVED_PATHS = [
	'extensions/copilot',
	'extensions/microsoft-authentication',
	'extensions/tunnel-forwarding',
	'build/azure-pipelines',
	'build/copilot-migrate-pr.ts',
];

const JS_DEBUG_BUILT_INS = [
	'ms-vscode.js-debug-companion',
	'ms-vscode.js-debug',
	'ms-vscode.vscode-js-profile-table',
];

suite('Integrity product surface guard', () => {
	test('removed Microsoft product trees stay absent', () => {
		for (const relativePath of REMOVED_PATHS) {
			const absolutePath = path.join(repoRoot, relativePath);
			assert.ok(
				!fs.existsSync(absolutePath),
				`Expected ${relativePath} to be absent; upstream merge may have restored unused Microsoft product surface.`
			);
		}
	});

	test('root compile and watch scripts do not invoke extensions/copilot', () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
		) as { scripts?: Record<string, string> };

		for (const scriptName of ['compile', 'watch'] as const) {
			const script = packageJson.scripts?.[scriptName] ?? '';
			assert.ok(
				!script.includes('extensions/copilot') && !script.includes('compile-copilot') && !script.includes('watch-copilot'),
				`${scriptName} must not compile the removed Copilot extension: ${script}`
			);
		}
	});

	test('extension tsconfig list keeps github-authentication and drops removed auth/tunnel extensions', () => {
		const gulpfile = fs.readFileSync(
			path.join(repoRoot, 'build', 'gulpfile.extensions.ts'),
			'utf8'
		);

		assert.match(gulpfile, /github-authentication\/tsconfig\.json/);
		assert.doesNotMatch(gulpfile, /microsoft-authentication\/tsconfig\.json/);
		assert.doesNotMatch(gulpfile, /tunnel-forwarding\/tsconfig\.json/);
	});

	test('product.json keeps js-debug built-ins and drops Copilot CDN leftovers', () => {
		const productJson = fs.readFileSync(path.join(repoRoot, 'product.json'), 'utf8');
		const product = JSON.parse(productJson) as {
			builtInExtensions?: { name: string }[];
			trustedExtensionAuthAccess?: Record<string, string[]>;
			webviewContentExternalBaseUrlTemplate?: string;
		};

		assert.ok(!product.webviewContentExternalBaseUrlTemplate, 'webviewContentExternalBaseUrlTemplate must stay removed');
		assert.ok(!productJson.includes('vscode-cdn.net'), 'product.json must not reference vscode-cdn.net');
		assert.ok(!productJson.includes('GitHub.copilot-chat'), 'product.json must not pre-trust GitHub.copilot-chat');

		const builtInNames = (product.builtInExtensions ?? []).map(entry => entry.name).sort();
		assert.deepStrictEqual(builtInNames, [...JS_DEBUG_BUILT_INS].sort());

		const githubTrust = product.trustedExtensionAuthAccess?.github ?? [];
		const githubEnterpriseTrust = product.trustedExtensionAuthAccess?.['github-enterprise'] ?? [];
		assert.deepStrictEqual(githubTrust, ['vscode.github']);
		assert.deepStrictEqual(githubEnterpriseTrust, ['vscode.github']);
		assert.ok(!product.trustedExtensionAuthAccess?.microsoft, 'Microsoft auth provider pre-trust must stay removed');
	});
});
