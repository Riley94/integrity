/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

/**
 * Integrity keeps only its own GitHub Actions workflows. Upstream microsoft/vscode
 * workflows target 1ES self-hosted pools, larger runners, Copilot LFS caches, and
 * Microsoft screenshot/telemetry services that this fork cannot use. After merging
 * upstream/main, delete any restored workflow YAMLs besides the allowlist below.
 */
const ALLOWED_WORKFLOW_YMLS = new Set(['ci.yml', 'release.yml']);

const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
	{ name: 'yarn', pattern: /\byarn\b/ },
	{ name: '1ES.Pool', pattern: /1ES\.Pool/ },
	{ name: 'macos-26-xlarge', pattern: /macos-26-xlarge/ },
	{ name: 'lfs: true', pattern: /lfs:\s*true/ },
];

suite('Integrity GitHub Actions workflows', () => {
	const workflowsDir = path.join(import.meta.dirname, '..', '..', '.github', 'workflows');

	test('only allowlisted workflow YAML files are present', () => {
		assert.ok(fs.existsSync(workflowsDir), `.github/workflows missing at ${workflowsDir}`);

		const ymlFiles = fs.readdirSync(workflowsDir)
			.filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
			.sort();

		assert.deepStrictEqual(
			ymlFiles,
			[...ALLOWED_WORKFLOW_YMLS].sort(),
			`Unexpected workflow YAML files under .github/workflows. After merging upstream/main, keep only ${[...ALLOWED_WORKFLOW_YMLS].join(', ')} and delete the rest.`
		);
	});

	test('allowlisted workflows do not use yarn, Microsoft runners, or LFS checkout', () => {
		for (const name of ALLOWED_WORKFLOW_YMLS) {
			const filePath = path.join(workflowsDir, name);
			assert.ok(fs.existsSync(filePath), `Expected workflow file missing: ${name}`);
			const contents = fs.readFileSync(filePath, 'utf8');

			for (const { name: patternName, pattern } of FORBIDDEN_PATTERNS) {
				assert.ok(
					!pattern.test(contents),
					`${name} must not contain ${patternName}`
				);
			}
		}
	});
});
