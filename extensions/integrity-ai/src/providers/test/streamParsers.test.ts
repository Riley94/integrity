/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
	AnthropicToolCallAccumulator,
	OpenAIToolCallAccumulator,
	parseOllamaChatLine,
	resetToolCallIdCounter,
	toolsToAnthropicFormat,
	toolsToOpenAIFormat,
} from '../streamParsers';

describe('toolsToOpenAIFormat', () => {
	it('wraps tools as OpenAI functions', () => {
		const formatted = toolsToOpenAIFormat([
			{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
		]);
		assert.deepEqual(formatted, [{
			type: 'function',
			function: {
				name: 'read_file',
				description: 'Read a file',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			},
		}]);
	});
});

describe('toolsToAnthropicFormat', () => {
	it('maps parameters to input_schema', () => {
		const formatted = toolsToAnthropicFormat([
			{ name: 'list_dir', description: 'List directory' },
		]);
		assert.deepEqual(formatted, [{
			name: 'list_dir',
			description: 'List directory',
			input_schema: { type: 'object', properties: {} },
		}]);
	});
});

describe('parseOllamaChatLine', () => {
	beforeEach(() => resetToolCallIdCounter());

	it('parses text content', () => {
		const parts = parseOllamaChatLine(JSON.stringify({ message: { content: 'hello' } }));
		assert.deepEqual(parts, [{ type: 'text', text: 'hello' }]);
	});

	it('parses tool_calls with object arguments', () => {
		const parts = parseOllamaChatLine(JSON.stringify({
			message: {
				content: '',
				tool_calls: [{
					id: 'c1',
					function: { name: 'read_file', arguments: { path: 'a.ts' } },
				}],
			},
		}));
		assert.equal(parts.length, 1);
		assert.equal(parts[0].type, 'tool_call');
		if (parts[0].type === 'tool_call') {
			assert.equal(parts[0].toolCall.id, 'c1');
			assert.equal(parts[0].toolCall.name, 'read_file');
			assert.deepEqual(parts[0].toolCall.arguments, { path: 'a.ts' });
		}
	});

	it('ignores malformed lines', () => {
		assert.deepEqual(parseOllamaChatLine('not-json'), []);
	});
});

describe('OpenAIToolCallAccumulator', () => {
	beforeEach(() => resetToolCallIdCounter());

	it('streams text deltas', () => {
		const acc = new OpenAIToolCallAccumulator();
		const parts = acc.ingest(JSON.stringify({
			choices: [{ delta: { content: 'Hi' } }],
		}));
		assert.deepEqual(parts, [{ type: 'text', text: 'Hi' }]);
		assert.deepEqual(acc.finish(), []);
	});

	it('accumulates fragmented tool_call deltas', () => {
		const acc = new OpenAIToolCallAccumulator();
		acc.ingest(JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_' } }] } }],
		}));
		acc.ingest(JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path"' } }] } }],
		}));
		acc.ingest(JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x.ts"}' } }] } }],
		}));
		const finished = acc.finish();
		assert.equal(finished.length, 1);
		assert.equal(finished[0].type, 'tool_call');
		if (finished[0].type === 'tool_call') {
			assert.equal(finished[0].toolCall.name, 'read_file');
			assert.deepEqual(finished[0].toolCall.arguments, { path: 'x.ts' });
		}
	});

	it('handles [DONE]', () => {
		const acc = new OpenAIToolCallAccumulator();
		assert.deepEqual(acc.ingest('[DONE]'), []);
	});
});

describe('AnthropicToolCallAccumulator', () => {
	beforeEach(() => resetToolCallIdCounter());

	it('emits text deltas', () => {
		const acc = new AnthropicToolCallAccumulator();
		const parts = acc.ingest(JSON.stringify({
			type: 'content_block_delta',
			delta: { type: 'text_delta', text: 'hello' },
		}));
		assert.deepEqual(parts, [{ type: 'text', text: 'hello' }]);
	});

	it('assembles tool_use blocks', () => {
		const acc = new AnthropicToolCallAccumulator();
		acc.ingest(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'tu_1', name: 'list_dir' },
		}));
		acc.ingest(JSON.stringify({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '{"path":' },
		}));
		acc.ingest(JSON.stringify({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '"."}' },
		}));
		const parts = acc.ingest(JSON.stringify({
			type: 'content_block_stop',
			index: 0,
		}));
		assert.equal(parts.length, 1);
		assert.equal(parts[0].type, 'tool_call');
		if (parts[0].type === 'tool_call') {
			assert.equal(parts[0].toolCall.id, 'tu_1');
			assert.equal(parts[0].toolCall.name, 'list_dir');
			assert.deepEqual(parts[0].toolCall.arguments, { path: '.' });
		}
	});
});
