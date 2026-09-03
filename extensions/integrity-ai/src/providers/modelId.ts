/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId } from './types';

/**
 * Maps a model picker id (`ollama:qwen2.5-coder:14b`) to provider + model name.
 */
export function parseModelId(modelId: string): { providerId: ProviderId; model: string } {
	const colon = modelId.indexOf(':');
	if (colon <= 0) {
		return { providerId: 'ollama', model: modelId };
	}
	const providerId = modelId.slice(0, colon) as ProviderId;
	const model = modelId.slice(colon + 1);
	if (providerId === 'ollama' || providerId === 'openai-compat' || providerId === 'anthropic') {
		return { providerId, model };
	}
	return { providerId: 'ollama', model: modelId };
}
