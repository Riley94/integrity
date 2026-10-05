/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
	applyJsonToolCallFallback,
	classifyPrintedToolCall,
	decideUnparsedPrintedTool,
	parseJsonToolCall,
	printedToolCallMessage,
	resetJsonFallbackIdCounter,
	unparsedPrintedToolStopMessage,
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

describe('classifyPrintedToolCall', () => {
	beforeEach(() => {
		resetJsonFallbackIdCounter();
	});

	it('parses a printed name/arguments call', () => {
		const printed = classifyPrintedToolCall('{"name":"integrity_apply_patch","arguments":{"path":"main.py"}}');
		assert.equal(printed?.kind, 'parsed');
		if (printed?.kind === 'parsed') {
			assert.equal(printed.toolCall.name, 'integrity_apply_patch');
			assert.deepEqual(printed.toolCall.arguments, { path: 'main.py' });
		}
	});

	it('repairs raw quotes inside a printed patch', () => {
		const text = [
			'The main.py file has been reviewed. I will apply the patch.',
			'{',
			'  "name": "integrity_apply_patch",',
			'  "arguments": {',
			'    "path": "main.py",',
			'    "hunks": [{ "oldText": "x", "newText": "text=\\"=\\"" }]',
			'  }',
			'}',
		].join('\n');
		const broken = text.replace('text=\\"=\\"', 'text="="');
		const result = parseJsonToolCall(broken);
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'integrity_apply_patch');
		assert.deepEqual(result!.toolCall.arguments, {
			path: 'main.py',
			hunks: [{ oldText: 'x', newText: 'text="="' }],
		});
		assert.equal(result!.remainingText, 'The main.py file has been reviewed. I will apply the patch.');
		const printed = classifyPrintedToolCall(broken);
		assert.equal(printed?.kind, 'parsed');
	});

	it('parses a patch whose newText is a Python triple-quoted string', () => {
		const text = [
			'This patch adds a calculator.',
			'{',
			'  "name": "integrity_apply_patch",',
			'  "arguments": {',
			'    "file_path": "main_app.py",',
			'    "hunks": [{',
			'      "oldText": "# Create the main application window",',
			'      "newText": """',
			'def calculator():',
			'    button = tk.Button(calc_window, text="=", command=button_equal)',
			'    other = tk.Button(calc_window, text="1", padx=40)',
			'"""',
			'    }]',
			'  }',
			'}',
		].join('\n');
		const result = parseJsonToolCall(text);
		assert.ok(result);
		assert.equal(result!.toolCall.name, 'integrity_apply_patch');
		const hunks = result!.toolCall.arguments.hunks as Array<{ oldText: string; newText: string }>;
		assert.equal(hunks[0].oldText, '# Create the main application window');
		assert.match(hunks[0].newText, /text="="/);
		assert.match(hunks[0].newText, /text="1", padx=40/);
		assert.equal(result!.toolCall.arguments.file_path, 'main_app.py');
		assert.equal(result!.remainingText, 'This patch adds a calculator.');
		assert.equal(classifyPrintedToolCall(text)?.kind, 'parsed');
	});

	it('parses a single-quoted triple string', () => {
		const text = `{"name":"integrity_apply_patch","arguments":{"path":"main.py","newText":'''say "hi"'''}}`;
		const result = parseJsonToolCall(text);
		assert.ok(result);
		assert.equal(result!.toolCall.arguments.newText, 'say "hi"');
	});

	it('repairs a raw newline inside a JSON string', () => {
		const text = '{"name":"integrity_apply_patch","arguments":{"newText":"line1\nline2"}}';
		const result = parseJsonToolCall(text);
		assert.ok(result);
		assert.equal(result!.toolCall.arguments.newText, 'line1\nline2');
	});

	it('names the tool when the printed JSON still does not parse', () => {
		const text = '{\n  "name": "integrity_apply_patch",\n  "arguments": {\n    "path": "main.py"';
		assert.equal(parseJsonToolCall(text), null);
		assert.deepEqual(classifyPrintedToolCall(text), { kind: 'unparsed', name: 'integrity_apply_patch' });
		const message = printedToolCallMessage('integrity_apply_patch');
		assert.match(message, /did not parse/);
		assert.match(message, /Escape every double quote/);
		assert.match(message, /triple quotes/);
		assert.doesNotMatch(message, /Do not print the call as JSON/);
	});

	it('leaves a quote followed by a comma unparsed', () => {
		const text = '{"name":"integrity_apply_patch","arguments":{"newText":"text="1", padx"}}';
		assert.equal(parseJsonToolCall(text), null);
		assert.deepEqual(classifyPrintedToolCall(text), { kind: 'unparsed', name: 'integrity_apply_patch' });
	});

	it('corrects an unparsed tool once and then stops', () => {
		const first = decideUnparsedPrintedTool(new Set(), 'integrity_apply_patch');
		assert.equal(first.action, 'correct');
		assert.equal(first.corrected.has('integrity_apply_patch'), true);
		const second = decideUnparsedPrintedTool(first.corrected, 'integrity_apply_patch');
		assert.equal(second.action, 'stop');
		assert.equal(second.corrected, first.corrected);
		const other = decideUnparsedPrintedTool(first.corrected, 'integrity_read_file');
		assert.equal(other.action, 'correct');
		assert.match(unparsedPrintedToolStopMessage('integrity_apply_patch'), /was not applied/);
	});

	it('ignores prose that does not print a tool call', () => {
		assert.equal(classifyPrintedToolCall('I will update main.py next.'), undefined);
	});
});
