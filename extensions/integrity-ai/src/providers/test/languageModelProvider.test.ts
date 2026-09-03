/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseModelId } from '../modelId';

describe('parseModelId', () => {
	it('splits provider and model', () => {
		assert.deepEqual(parseModelId('ollama:qwen2.5-coder:14b'), {
			providerId: 'ollama',
			model: 'qwen2.5-coder:14b',
		});
	});

	it('handles openai-compat', () => {
		assert.deepEqual(parseModelId('openai-compat:gpt-4o-mini'), {
			providerId: 'openai-compat',
			model: 'gpt-4o-mini',
		});
	});

	it('defaults unknown prefixes to ollama with full id as model', () => {
		assert.deepEqual(parseModelId('unknown:model'), {
			providerId: 'ollama',
			model: 'unknown:model',
		});
	});

	it('defaults bare ids to ollama', () => {
		assert.deepEqual(parseModelId('llama3'), {
			providerId: 'ollama',
			model: 'llama3',
		});
	});
});
