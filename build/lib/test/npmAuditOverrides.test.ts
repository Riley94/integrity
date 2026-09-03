/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Patched leaf versions pinned via root package.json overrides to clear npm
 * audit findings without forced major upgrades of gulp / foundry-local-sdk.
 */
const REQUIRED_OVERRIDES: Readonly<Record<string, string>> = {
	'@humanfs/node': '0.16.8',
	'@xmldom/xmldom': '0.8.15',
	'adm-zip': '0.6.0',
	'braces': '3.0.3',
	'browserslist': '4.28.7',
	'decode-uri-component': '0.5.0',
	'fast-uri': '3.1.6',
	'qs': '6.16.0',
};

type LockfilePackage = {
	version?: string;
	dependencies?: Record<string, string>;
};

type Lockfile = {
	packages?: Record<string, LockfilePackage>;
};

/**
 * Compare dotted numeric semver strings (major.minor.patch only).
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map(part => Number.parseInt(part, 10));
	const pb = b.split('.').map(part => Number.parseInt(part, 10));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) {
			return da - db;
		}
	}
	return 0;
}

/**
 * Resolve the package name for a lockfile `packages` key such as
 * `node_modules/braces` or `node_modules/findup-sync/node_modules/braces`.
 */
function packageNameFromLockPath(lockPath: string): string | undefined {
	const marker = 'node_modules/';
	const idx = lockPath.lastIndexOf(marker);
	if (idx === -1) {
		return undefined;
	}
	return lockPath.slice(idx + marker.length);
}

suite('npm audit overrides', () => {
	test('root package.json pins required advisory overrides', () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
		) as { overrides?: Record<string, string | object> };

		assert.ok(packageJson.overrides, 'package.json must define overrides');
		for (const [name, version] of Object.entries(REQUIRED_OVERRIDES)) {
			assert.strictEqual(
				packageJson.overrides[name],
				version,
				`override for ${name} must be ${version}`
			);
		}
	});

	test('package-lock.json resolves every overridden package to a patched version', () => {
		const lockfile = JSON.parse(
			fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')
		) as Lockfile;

		assert.ok(lockfile.packages, 'package-lock.json must contain packages');

		const found = new Map<string, string[]>();
		for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
			if (!entry.version) {
				continue;
			}
			const name = packageNameFromLockPath(lockPath);
			if (!name || !(name in REQUIRED_OVERRIDES)) {
				continue;
			}
			const versions = found.get(name) ?? [];
			versions.push(entry.version);
			found.set(name, versions);
		}

		for (const [name, minimum] of Object.entries(REQUIRED_OVERRIDES)) {
			const versions = found.get(name);
			assert.ok(versions && versions.length > 0, `expected ${name} in package-lock.json`);
			for (const version of versions) {
				assert.ok(
					compareSemver(version, minimum) >= 0,
					`${name}@${version} at lockfile entry must be >= ${minimum}`
				);
			}
		}
	});
});
