/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	rejectionForBrowserToolCall,
	rejectionForMisroutedToolCall,
	rejectionForPathFishingAskQuestions,
} from '../browserToolGuard';

describe('rejectionForBrowserToolCall', () => {
	it('rejects Python input/print scripts without page refs', () => {
		const msg = rejectionForBrowserToolCall('run_playwright_code', {
			pageId: 'main.py',
			code: 'a = int(input())\nb = int(input())\nprint(a + b)',
		});
		assert.ok(msg);
		assert.match(msg!, /integrity_apply_patch/);
		assert.match(msg!, /integrity_read_file/);
	});

	it('rejects workspace-source code even with a normal pageId', () => {
		const msg = rejectionForBrowserToolCall('run_playwright_code', {
			pageId: 'page-123',
			code: 'def add(a, b):\n    return a + b\nprint(add(1, 2))',
		});
		assert.ok(msg);
	});

	it('allows Playwright snippets that use page', () => {
		assert.equal(
			rejectionForBrowserToolCall('run_playwright_code', {
				pageId: 'page-123',
				code: 'return page.evaluate(() => document.title)',
			}),
			undefined,
		);
		assert.equal(
			rejectionForBrowserToolCall('run_playwright_code', {
				pageId: 'page-123',
				code: 'await page.click("button"); print("done")',
			}),
			undefined,
		);
	});

	it('allows deferred waits with no code', () => {
		assert.equal(
			rejectionForBrowserToolCall('run_playwright_code', {
				pageId: 'page-123',
				deferredResultId: 'abc',
			}),
			undefined,
		);
	});

	it('rejects open_browser_page with a workspace path', () => {
		const msg = rejectionForBrowserToolCall('open_browser_page', { url: 'main.py' });
		assert.ok(msg);
		assert.match(msg!, /integrity_apply_patch/);
	});

	it('allows open_browser_page with http(s)/file/about URLs', () => {
		assert.equal(
			rejectionForBrowserToolCall('open_browser_page', { url: 'https://example.com' }),
			undefined,
		);
		assert.equal(
			rejectionForBrowserToolCall('open_browser_page', { url: 'file:///tmp/x.html' }),
			undefined,
		);
		assert.equal(
			rejectionForBrowserToolCall('open_browser_page', { url: 'about:blank' }),
			undefined,
		);
	});

	it('ignores unrelated tools', () => {
		assert.equal(
			rejectionForBrowserToolCall('integrity_read_file', { path: 'main.py' }),
			undefined,
		);
	});
});

describe('rejectionForPathFishingAskQuestions', () => {
	it('rejects askQuestions that request a file path', () => {
		const msg = rejectionForPathFishingAskQuestions('vscode_askQuestions', {
			questions: [{
				header: 'file-path',
				question: 'Please provide the workspace-relative path to the file you want to work with (e.g., main.py or src/main.py).',
			}],
		});
		assert.ok(msg);
		assert.match(msg!, /integrity_file_search/);
		assert.match(msg!, /do not ask/i);
	});

	it('allows unrelated askQuestions', () => {
		assert.equal(
			rejectionForPathFishingAskQuestions('vscode_askQuestions', {
				questions: [{ question: 'Which test framework should we use?' }],
			}),
			undefined,
		);
	});
});

describe('rejectionForMisroutedToolCall', () => {
	it('covers browser and path-fishing cases', () => {
		assert.ok(rejectionForMisroutedToolCall('open_browser_page', { url: 'main.py' }));
		assert.ok(rejectionForMisroutedToolCall('vscode_askQuestions', {
			questions: [{ question: 'What is the correct file path?' }],
		}));
	});
});
