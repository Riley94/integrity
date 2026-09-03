/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
	applyJsonToolCallFallback,
	parseJsonToolCall,
	resetJsonFallbackIdCounter,
} from '../jsonToolFallback';

describe('parseJsonToolCall', () => {
	beforeEach(() => {
		resetJsonFallbackIdCounter();
	});

	it('parses bare Integrity JSON tool calls', () => {
		const result = parseJsonToolCall('{"tool":"read_file","args":{"path":"src/a.ts"}}');
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'read_file');
		assert.deepEqual(result!.toolCall.arguments, { path: 'src/a.ts' });
	});

	it('parses fenced JSON blocks', () => {
		const result = parseJsonToolCall('Sure.\n```json\n{"tool":"list_dir","args":{"path":"."}}\n```\n');
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'list_dir');
	});

	it('parses OpenAI-ish name/arguments shape', () => {
		const result = parseJsonToolCall('{"name":"grep_search","arguments":{"pattern":"TODO"}}');
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'grep_search');
		assert.deepEqual(result!.toolCall.arguments, { pattern: 'TODO' });
	});

	it('parses stringified arguments', () => {
		const result = parseJsonToolCall('{"tool":"search","args":"{\\"pattern\\":\\"foo\\"}"}');
		assert.ok(result);
		assert.deepEqual(result!.toolCall.arguments, { pattern: 'foo' });
	});

	it('returns null for plain prose', () => {
		assert.equal(parseJsonToolCall('Here is a summary of the changes.'), null);
	});

	it('returns null for invalid JSON object without tool fields', () => {
		assert.equal(parseJsonToolCall('{"hello":"world"}'), null);
	});

	it('extracts JSON embedded in prose', () => {
		const result = parseJsonToolCall('I will read the file now {"tool":"read_file","args":{"path":"x"}} done');
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'read_file');
	});
});

describe('applyJsonToolCallFallback', () => {
	beforeEach(() => {
		resetJsonFallbackIdCounter();
	});

	it('skips fallback when native tool calls already existed', () => {
		const result = applyJsonToolCallFallback('{"tool":"read_file","args":{"path":"a"}}', true);
		assert.equal(result.toolCalls.length, 0);
		assert.ok(result.text.includes('read_file'));
	});

	it('recovers a tool call from text-only responses', () => {
		const result = applyJsonToolCallFallback('{"tool":"read_file","args":{"path":"a"}}', false);
		assert.equal(result.toolCalls.length, 1);
		assert.equal(result.toolCalls[0].name, 'read_file');
	});
});
