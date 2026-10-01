/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt, modeSystemPrompt, toolTurnInstructions } from '../agentPrompt';

describe('modeSystemPrompt', () => {
	it('keeps Ask/Edit/Agent prefixes', () => {
		assert.match(modeSystemPrompt('ask'), /Ask mode/);
		assert.match(modeSystemPrompt('edit'), /Edit mode/);
		assert.match(modeSystemPrompt('agent'), /Agent mode/);
	});
});

describe('toolTurnInstructions', () => {
	it('names only the selected tool', () => {
		const text = toolTurnInstructions([{
			name: 'integrity_read_file',
			description: 'Read a workspace file.',
		}]);
		assert.match(text, /Call only integrity_read_file/);
		assert.match(text, /Read a workspace file/);
		assert.doesNotMatch(text, /vscode_askQuestions/);
		assert.doesNotMatch(text, /integrity_apply_patch/);
	});

	it('names every selected tool and no others', () => {
		const text = toolTurnInstructions([
			{ name: 'integrity_create_file', description: 'Create a file.' },
			{ name: 'integrity_apply_patch', description: 'Apply a patch.' },
		]);
		assert.match(text, /Call only integrity_create_file, integrity_apply_patch/);
		assert.match(text, /Create a file/);
		assert.match(text, /Apply a patch/);
		assert.doesNotMatch(text, /integrity_read_file/);
	});

	it('withholds every tool when Jev selected none', () => {
		const text = toolTurnInstructions([]);
		assert.match(text, /no tools/);
		assert.match(text, /Do not call tools/);
		assert.doesNotMatch(text, /integrity_/);
	});
});

describe('buildSystemPrompt', () => {
	it('includes only the selected tool', () => {
		const prompt = buildSystemPrompt('agent', '', '', [{
			name: 'integrity_read_file',
			description: 'Read a workspace file.',
		}]);
		assert.match(prompt, /integrity_read_file/);
		assert.doesNotMatch(prompt, /vscode_askQuestions/);
		assert.doesNotMatch(prompt, /run_in_terminal/);
	});

	it('includes every selected tool', () => {
		const prompt = buildSystemPrompt('agent', '', '', [
			{ name: 'integrity_create_file', description: 'Create a file.' },
			{ name: 'integrity_apply_patch', description: 'Apply a patch.' },
		]);
		assert.match(prompt, /integrity_create_file/);
		assert.match(prompt, /integrity_apply_patch/);
		assert.doesNotMatch(prompt, /integrity_read_file/);
	});

	it('tells a text-only turn not to call tools', () => {
		const prompt = buildSystemPrompt('agent', '', '');
		assert.match(prompt, /This turn has no tools/);
		assert.doesNotMatch(prompt, /integrity_apply_patch/);
		assert.doesNotMatch(prompt, /vscode_askQuestions/);
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

	it('tells the writer to run Python before answering when the host rule requires it', () => {
		const prompt = buildSystemPrompt('agent', '', '', [{
			name: 'integrity_scratchpad',
			description: 'Run a short Python 3 snippet.',
		}], true);
		assert.match(prompt, /integrity_scratchpad/);
		assert.match(prompt, /before answering/);
		assert.match(prompt, /stdout and stderr/);
	});
});
