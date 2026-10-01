/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyScratchpadHostRule,
	holdReplyForScratchpad,
	promptRequiresScratchpad,
	SCRATCHPAD_REQUIRED_MESSAGE,
} from '../scratchpadHostRule';
import { IntegrityToolName } from '../toolNames';

const NESTED_MODEL_BUG = `
Modeling's separability_matrix does not compute separability correctly for nested CompoundModels.

\`\`\`python
cm = m.Linear1D(10) & m.Linear1D(5)
\`\`\`

\`\`\`python
>>> separability_matrix(m.Pix2Sky_TAN() & cm)
array([[ True,  True, False, False],
       [ True,  True, False, False],
       [False, False,  True,  True],
       [False, False,  True,  True]])
\`\`\`

Suddenly the inputs and outputs are no longer separable?

This feels like a bug to me, but I might be missing something?
`;

const scratchpad = { name: IntegrityToolName.Scratchpad, description: 'Run Python.' };
const readFile = { name: IntegrityToolName.ReadFile, description: 'Read a file.' };

describe('promptRequiresScratchpad', () => {
	it('matches a bug report that pastes Python and a REPL session', () => {
		assert.equal(promptRequiresScratchpad(NESTED_MODEL_BUG), true);
	});

	it('matches a question about what a snippet returns', () => {
		const prompt = 'What does this return?\n```python\nprint(1 + 1)\n```';
		assert.equal(promptRequiresScratchpad(prompt), true);
	});

	it('matches a defect claim without a question mark', () => {
		const prompt = 'This function returns the wrong value.\n```python\ndef f():\n    return 1\n```';
		assert.equal(promptRequiresScratchpad(prompt), true);
	});

	it('matches a pasted REPL session even without defect words in the prose', () => {
		const prompt = 'Look at this session.\n```python\n>>> 1 + 1\n2\n```';
		assert.equal(promptRequiresScratchpad(prompt), true);
	});

	it('leaves an edit request on Jev\'s choice', () => {
		const prompt = 'Rename this function to bar.\n```python\ndef foo():\n    return 1\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});

	it('leaves a naming question alone', () => {
		const prompt = 'How should I name this?\n```python\ndef foo():\n    pass\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});

	it('matches untagged fences when the body is Python', () => {
		const prompt = [
			"Modeling's separability_matrix does not compute separability correctly for nested CompoundModels",
			'',
			'```',
			'from astropy.modeling import models as m',
			'cm = m.Linear1D(10) & m.Linear1D(5)',
			'```',
			'',
			'```',
			'>>> separability_matrix(m.Pix2Sky_TAN() & cm)',
			'array([[ True, False],[False, True]])',
			'```',
			'',
			'Suddenly the inputs and outputs are no longer separable?',
		].join('\n');
		assert.equal(promptRequiresScratchpad(prompt), true);
	});

	it('ignores an untagged shell fence', () => {
		const prompt = 'This script fails.\n```\necho hello\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});

	it('ignores a non-Python fence', () => {
		const prompt = 'This output looks wrong.\n```js\nconsole.log(1)\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});

	it('ignores an empty Python fence', () => {
		const prompt = 'This output looks wrong.\n```python\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});

	it('ignores a runtime question that has no snippet', () => {
		assert.equal(promptRequiresScratchpad('What is the output of separability_matrix?'), false);
	});

	it('does not treat words inside the fence as the question', () => {
		const prompt = 'Please tidy this up.\n```python\n# this output looks wrong\nraise ValueError("bug")\n```';
		assert.equal(promptRequiresScratchpad(prompt), false);
	});
});

describe('applyScratchpadHostRule', () => {
	it('adds the scratchpad when Jev chose a text-only turn', () => {
		const ruled = applyScratchpadHostRule([], [readFile, scratchpad], NESTED_MODEL_BUG);
		assert.equal(ruled.forced, true);
		assert.deepEqual(ruled.tools.map(tool => tool.name), [IntegrityToolName.Scratchpad]);
	});

	it('keeps Jev\'s other tools and appends the scratchpad', () => {
		const ruled = applyScratchpadHostRule([readFile], [readFile, scratchpad], NESTED_MODEL_BUG);
		assert.equal(ruled.forced, true);
		assert.deepEqual(ruled.tools.map(tool => tool.name), [
			IntegrityToolName.ReadFile,
			IntegrityToolName.Scratchpad,
		]);
	});

	it('does not duplicate a scratchpad Jev already kept', () => {
		const ruled = applyScratchpadHostRule([scratchpad], [readFile, scratchpad], NESTED_MODEL_BUG);
		assert.equal(ruled.forced, true);
		assert.deepEqual(ruled.tools, [scratchpad]);
	});

	it('does not put the scratchpad back when the catalog omitted it', () => {
		const ruled = applyScratchpadHostRule([readFile], [readFile], NESTED_MODEL_BUG);
		assert.equal(ruled.forced, false);
		assert.deepEqual(ruled.tools, [readFile]);
	});

	it('leaves an edit request on the tools Jev selected', () => {
		const prompt = 'Rename this function to bar.\n```python\ndef foo():\n    return 1\n```';
		const ruled = applyScratchpadHostRule([], [readFile, scratchpad], prompt);
		assert.equal(ruled.forced, false);
		assert.deepEqual(ruled.tools, []);
	});
});

describe('holdReplyForScratchpad', () => {
	const exit = { action: 'exit' as const, unavailable: false };
	const incomplete = {
		action: 'continue' as const,
		message: 'Jev marked this turn as incomplete. Continue the task. Do not repeat the previous summary.',
		unavailable: false,
	};
	const stopped = {
		action: 'stop' as const,
		message: 'This turn cannot be finished until Jev answers.',
		unavailable: true,
	};

	it('blocks a complete verdict until the scratchpad has run', () => {
		const held = holdReplyForScratchpad(exit, true);
		assert.equal(held.action, 'continue');
		assert.equal(held.unavailable, false);
		assert.equal(held.message, SCRATCHPAD_REQUIRED_MESSAGE);
	});

	it('replaces the generic incomplete message with the scratchpad instruction', () => {
		const held = holdReplyForScratchpad(incomplete, true);
		assert.equal(held.action, 'continue');
		assert.equal(held.message, SCRATCHPAD_REQUIRED_MESSAGE);
	});

	it('does not stop the turn on a missing completion score before the snippet runs', () => {
		const held = holdReplyForScratchpad(stopped, true);
		assert.equal(held.action, 'continue');
		assert.equal(held.unavailable, false);
		assert.equal(held.message, SCRATCHPAD_REQUIRED_MESSAGE);
	});

	it('returns the same decision once the scratchpad is no longer required', () => {
		assert.equal(holdReplyForScratchpad(exit, false), exit);
		assert.equal(holdReplyForScratchpad(stopped, false), stopped);
	});
});
