/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateContextUsage, promptTextFromMessages, textFromMessageContent } from '../contextUsage';

describe('estimateContextUsage', () => {
	it('counts about four characters per token and skips empty text', () => {
		assert.deepEqual(estimateContextUsage('abcd', ''), { promptTokens: 1, completionTokens: 0 });
		assert.deepEqual(estimateContextUsage('', 'abcde'), { promptTokens: 0, completionTokens: 2 });
	});
});

describe('promptTextFromMessages', () => {
	it('joins string content, text parts, and tool calls', () => {
		const text = promptTextFromMessages([
			{ content: 'system' },
			{ content: [{ value: 'hello' }, { name: 'read_file', input: { path: 'a.ts' } }] },
		]);
		assert.equal(text, 'system\nhello\nread_file {"path":"a.ts"}');
		assert.equal(textFromMessageContent(undefined), '');
	});
});
