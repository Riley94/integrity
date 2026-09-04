/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt, modeSystemPrompt, TOOL_DECISION_GUIDE } from '../agentPrompt';

describe('modeSystemPrompt', () => {
	it('keeps Ask/Edit/Agent prefixes', () => {
		assert.match(modeSystemPrompt('ask'), /Ask mode/);
		assert.match(modeSystemPrompt('edit'), /Edit mode/);
		assert.match(modeSystemPrompt('agent'), /Agent mode/);
	});
});

describe('buildSystemPrompt', () => {
	it('includes the tool decision guide', () => {
		const prompt = buildSystemPrompt('agent', '', '');
		assert.ok(prompt.includes(TOOL_DECISION_GUIDE));
		assert.match(prompt, /integrity_apply_patch/);
		assert.match(prompt, /integrity_read_file/);
		assert.match(prompt, /Never use browser tools to author or edit workspace files/);
	});

	it('includes the mode sentence', () => {
		assert.match(buildSystemPrompt('ask', '', ''), /Ask mode/);
		assert.match(buildSystemPrompt('edit', '', ''), /Edit mode/);
		assert.match(buildSystemPrompt('agent', '', ''), /Agent mode/);
	});

	it('appends agent rules and context when provided', () => {
		const prompt = buildSystemPrompt('agent', 'No network.', 'File: main.py');
		assert.match(prompt, /Project agent rules/);
		assert.match(prompt, /No network\./);
		assert.match(prompt, /--- Context ---/);
		assert.match(prompt, /File: main\.py/);
	});
});
