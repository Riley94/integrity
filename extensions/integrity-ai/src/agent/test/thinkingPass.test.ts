/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildThinkingRequest, thinkingContextMessage } from '../thinkingPass';

describe('buildThinkingRequest', () => {
	it('names the four questions and withholds a solution and tool calls', () => {
		const text = buildThinkingRequest('Add a button');
		assert.match(text, /What is the user asking for\?/);
		assert.match(text, /What would make the result wrong or incomplete\?/);
		assert.match(text, /What must be checked or decided before answering or editing\?/);
		assert.match(text, /What is the first concrete step\?/);
		assert.match(text, /Do not solve the task/);
		assert.match(text, /Do not call tools/);
		assert.match(text, /Add a button/);
	});
});

describe('thinkingContextMessage', () => {
	it('turns a trace into a private note that must not be repeated', () => {
		const note = thinkingContextMessage('Check the button handler.');
		assert.ok(note);
		assert.match(note, /Follow them/);
		assert.match(note, /Do not repeat them in the visible reply/);
		assert.match(note, /Check the button handler\./);
	});

	it('returns nothing for a blank or whitespace trace', () => {
		assert.equal(thinkingContextMessage(''), undefined);
		assert.equal(thinkingContextMessage('   \n\t'), undefined);
	});
});
