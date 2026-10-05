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

	it('requires a control to perform its behavior unless the user asked for a placeholder', () => {
		const text = modeSystemPrompt('agent');
		assert.match(text, /control, command, or screen/);
		assert.match(text, /perform the behavior the user asked for/);
		assert.match(text, /placeholder/);
		assert.doesNotMatch(modeSystemPrompt('ask'), /placeholder/);
		assert.doesNotMatch(modeSystemPrompt('edit'), /placeholder/);
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

	it('lists files from earlier in the chat and tells the writer to stay in them', () => {
		const prompt = buildSystemPrompt('agent', '', '', [], false, [
			{ path: 'app.py', action: 'created' },
			{ path: 'src/calc.py', action: 'updated' },
		]);
		assert.match(prompt, /Files already changed in this chat/);
		assert.match(prompt, /app\.py \(created\)/);
		assert.match(prompt, /src\/calc\.py \(updated\)/);
		assert.match(prompt, /Do not start a new file or a new language unless the user asks/);
		assert.doesNotMatch(prompt, /before editing/);
	});

	it('tells the writer to read those files before editing only when that flag is set', () => {
		const files = [{ path: 'app.py', action: 'created' as const }];
		const tools = [{ name: 'integrity_read_file', description: 'Read a workspace file.' }];
		const without = buildSystemPrompt('agent', '', '', tools, false, files, false);
		const withRead = buildSystemPrompt('agent', '', '', tools, false, files, true);
		assert.doesNotMatch(without, /before editing/);
		assert.match(withRead, /Read these files with integrity_read_file before editing them/);
	});

	it('tells the writer to look before editing while that phase is active', () => {
		const prompt = buildSystemPrompt('agent', '', '', [{
			name: 'integrity_list_dir',
			description: 'List a directory.',
		}], false, [], false, true);
		assert.match(prompt, /Look at the workspace before editing/);
		assert.match(prompt, /what you will create or change/);
		assert.doesNotMatch(prompt, /--- Plan ---/);
	});

	it('keeps the plan and requires a read before the next patch', () => {
		const prompt = buildSystemPrompt('agent', '', '', [], false, [], false, false, 'Create calculator.py.');
		assert.match(prompt, /--- Plan ---/);
		assert.match(prompt, /Create calculator\.py\./);
		assert.match(prompt, /Follow the plan/);
		assert.match(prompt, /integrity_read_file before integrity_apply_patch or integrity_replace_string/);
		assert.match(prompt, /has not been read since its last write/);
		assert.doesNotMatch(prompt, /Look at the workspace before editing/);
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
