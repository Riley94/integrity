/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	COMPLETION_BLOCKED_MESSAGE,
	COMPLETION_UNVERIFIED_MESSAGE,
	approvalQuestionId,
	blockedMutatingToolMessage,
	TOOL_SURFACE_NONE_QUESTION,
	TOOL_SURFACE_QUESTION,
	buildApprovalRequest,
	buildRetrievalRequest,
	buildRoutingRequest,
	buildToolSurfaceRequest,
	filterToolsForSurface,
	formatRetrievedChunks,
	interpretApproval,
	interpretCompletion,
	interpretRetrieval,
	interpretRouting,
	interpretToolSurface,
	isMutatingTool,
	offeredToolSurfaces,
	retrievalQuestionId,
} from '../agentDecisions';
import type { JevAnswer } from '../jevClient';

const candidates = [
	{ id: 'ollama:qwen2.5-coder:14b', name: 'qwen 14b', family: 'ollama', maxInputTokens: 32768 },
	{ id: 'anthropic:claude', name: 'claude', family: 'anthropic', maxInputTokens: 200000 },
];

const hits = [
	{ path: 'src/a.ts', content: 'alpha', startLine: 1, endLine: 4 },
	{ path: 'src/b.ts', content: 'beta', startLine: 10, endLine: 12 },
];

function choice(choiceId: string, confidence: number): JevAnswer {
	return {
		type: 'choice',
		choice: choiceId,
		confidence,
		probabilities: { [choiceId]: confidence },
	};
}

function noul(value: number): JevAnswer {
	return { type: 'noul', noul: value };
}

describe('interpretRouting', () => {
	const base = {
		candidateIds: candidates.map(candidate => candidate.id),
		routingConfidence: 0.6,
	};

	it('switches when the choice is confident, allowlisted, and none-suitable is low', () => {
		const selected = interpretRouting({
			...base,
			unavailable: false,
			answers: {
				model: choice('anthropic:claude', 0.6),
				none_suitable: noul(0.59),
			},
		});
		assert.equal(selected, 'anthropic:claude');
	});

	it('keeps the user model on low confidence', () => {
		assert.equal(interpretRouting({
			...base,
			unavailable: false,
			answers: {
				model: choice('anthropic:claude', 0.59),
				none_suitable: noul(0.1),
			},
		}), undefined);
	});

	it('keeps the user model when none of the candidates are suitable', () => {
		assert.equal(interpretRouting({
			...base,
			unavailable: false,
			answers: {
				model: choice('anthropic:claude', 0.9),
				none_suitable: noul(0.6),
			},
		}), undefined);
	});

	it('keeps the user model when the chosen id is not allowlisted', () => {
		assert.equal(interpretRouting({
			...base,
			unavailable: false,
			answers: {
				model: choice('openai-compat:other', 0.99),
				none_suitable: noul(0),
			},
		}), undefined);
	});

	it('keeps the user model when Jev is unavailable', () => {
		assert.equal(interpretRouting({
			...base,
			unavailable: true,
			answers: undefined,
		}), undefined);
	});

	it('does not build a request when there are no candidates', () => {
		assert.equal(buildRoutingRequest('fix the bug', 'agent', 'ollama:qwen', []), undefined);
	});
});

const surfaceTools = [
	{ name: 'integrity_read_file', description: 'Read a file' },
	{ name: 'integrity_apply_patch', description: 'Apply a patch' },
	{ name: 'run_in_terminal', description: 'Run a command' },
];

describe('interpretToolSurface', () => {
	const offered = offeredToolSurfaces(surfaceTools.map(tool => tool.name));
	const base = {
		offered,
		toolSurfaceConfidence: 0.6,
	};

	it('selects a confident allowlisted ceiling when none-suitable is low', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('edit', 0.6),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.59),
			},
		}), 'edit');
	});

	it('keeps the full list on low confidence', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('read', 0.59),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.1),
			},
		}), undefined);
	});

	it('keeps the full list when none of the ceilings are suitable', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('act', 0.9),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.6),
			},
		}), undefined);
	});

	it('keeps the full list when the chosen id was not offered', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('browse', 0.99),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0),
			},
		}), undefined);
	});

	it('keeps the full list when Jev is unavailable', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: true,
			answers: undefined,
		}), undefined);
	});

	it('keeps the full list when the answer shape is wrong', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: noul(0.9),
				[TOOL_SURFACE_NONE_QUESTION]: choice('edit', 0.9),
			},
		}), undefined);
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('edit', 0.9),
			},
		}), undefined);
	});
});

describe('buildToolSurfaceRequest', () => {
	it('offers every distinct ceiling and sends the tool catalog', () => {
		const request = buildToolSurfaceRequest('fix the bug', 'agent', surfaceTools);
		assert.ok(request);
		const surface = request.questions[TOOL_SURFACE_QUESTION];
		assert.equal(surface.type, 'choice');
		if (surface.type === 'choice') {
			assert.deepEqual(Object.keys(surface.criteria), ['reply', 'read', 'edit', 'act']);
		}
		assert.equal(request.questions[TOOL_SURFACE_NONE_QUESTION].type, 'noul');
		const state = request.state as { mode: string; tools: { name: string; description: string }[] };
		assert.equal(state.mode, 'agent');
		assert.deepEqual(state.tools.map(tool => tool.name), surfaceTools.map(tool => tool.name));
	});

	it('drops ceilings that do not change the set', () => {
		const readOnly = buildToolSurfaceRequest('explain this', 'ask', [
			{ name: 'integrity_read_file', description: 'Read a file' },
			{ name: 'integrity_grep_search', description: 'Search' },
		]);
		assert.ok(readOnly);
		const readSurface = readOnly.questions[TOOL_SURFACE_QUESTION];
		assert.equal(readSurface.type, 'choice');
		if (readSurface.type === 'choice') {
			assert.deepEqual(Object.keys(readSurface.criteria), ['reply', 'read']);
		}

		const editOnly = buildToolSurfaceRequest('rename the function', 'edit', [
			{ name: 'integrity_read_file', description: 'Read a file' },
			{ name: 'integrity_apply_patch', description: 'Apply a patch' },
		]);
		assert.ok(editOnly);
		const editSurface = editOnly.questions[TOOL_SURFACE_QUESTION];
		assert.equal(editSurface.type, 'choice');
		if (editSurface.type === 'choice') {
			assert.deepEqual(Object.keys(editSurface.criteria), ['reply', 'read', 'edit']);
		}
	});

	it('does not build a request when there are no tools', () => {
		assert.equal(buildToolSurfaceRequest('hello', 'agent', []), undefined);
		assert.deepEqual(offeredToolSurfaces([]), []);
	});

	it('clips long tool descriptions', () => {
		const request = buildToolSurfaceRequest('hello', 'ask', [
			{ name: 'integrity_read_file', description: 'x'.repeat(500) },
		]);
		assert.ok(request);
		const state = request.state as { tools: { description: string }[] };
		assert.equal(state.tools[0].description.length, 401);
		assert.ok(state.tools[0].description.endsWith('…'));
	});
});

describe('filterToolsForSurface', () => {
	it('maps each ceiling onto the nested tool list', () => {
		assert.deepEqual(filterToolsForSurface(surfaceTools, 'reply'), []);
		assert.deepEqual(
			filterToolsForSurface(surfaceTools, 'read').map(tool => tool.name),
			['integrity_read_file'],
		);
		assert.deepEqual(
			filterToolsForSurface(surfaceTools, 'edit').map(tool => tool.name),
			['integrity_read_file', 'integrity_apply_patch'],
		);
		assert.deepEqual(filterToolsForSurface(surfaceTools, 'act'), surfaceTools);
	});
});

describe('interpretRetrieval', () => {
	it('drops chunks under the threshold', () => {
		const request = buildRetrievalRequest('where is main', hits);
		assert.ok(request);
		assert.equal(request.questions[retrievalQuestionId(0)].type, 'noul');
		const kept = interpretRetrieval({
			hits,
			unavailable: false,
			threshold: 0.5,
			onUnavailable: 'drop-all',
			answers: {
				[retrievalQuestionId(0)]: noul(0.5),
				[retrievalQuestionId(1)]: noul(0.49),
			},
		});
		assert.deepEqual(kept.map(hit => hit.path), ['src/a.ts']);
	});

	it('returns every hit when the tool-path rank fails', () => {
		assert.deepEqual(interpretRetrieval({
			hits,
			answers: undefined,
			unavailable: true,
			threshold: 0.5,
			onUnavailable: 'keep-all',
		}), hits);
	});

	it('injects nothing when the prefetch rank fails', () => {
		const kept = interpretRetrieval({
			hits,
			answers: undefined,
			unavailable: true,
			threshold: 0.5,
			onUnavailable: 'drop-all',
		});
		assert.deepEqual(kept, []);
		assert.equal(formatRetrievedChunks(kept), '');
	});
});

describe('interpretApproval', () => {
	it('does not treat read-only tools as mutating', () => {
		assert.equal(isMutatingTool('integrity_read_file'), false);
		assert.equal(isMutatingTool('integrity_codebase_search'), false);
		assert.equal(isMutatingTool('integrity_apply_patch'), true);
		assert.equal(isMutatingTool('run_in_terminal'), true);
	});

	it('blocks mutating calls when Jev does not answer', () => {
		const verdict = interpretApproval({
			toolName: 'integrity_apply_patch',
			answer: undefined,
			unavailable: true,
			approvalThreshold: 0.7,
			requireEditApproval: false,
			requireTerminalApproval: false,
		});
		assert.equal(verdict.action, 'block');
		assert.equal(verdict.message, blockedMutatingToolMessage('integrity_apply_patch'));
	});

	it('still prompts when edit approval is required even if Jev says the call is safe', () => {
		const verdict = interpretApproval({
			toolName: 'integrity_apply_patch',
			answer: noul(0.1),
			unavailable: false,
			approvalThreshold: 0.7,
			requireEditApproval: true,
			requireTerminalApproval: false,
		});
		assert.equal(verdict.action, 'prompt');
	});

	it('prompts a disabled edit floor only at or above the threshold', () => {
		const shared = {
			toolName: 'integrity_create_file',
			unavailable: false,
			approvalThreshold: 0.7,
			requireEditApproval: false,
			requireTerminalApproval: true,
		};
		assert.equal(interpretApproval({ ...shared, answer: noul(0.69) }).action, 'invoke');
		assert.equal(interpretApproval({ ...shared, answer: noul(0.7) }).action, 'prompt');
	});

	it('uses the terminal approval floor for terminal tools', () => {
		const verdict = interpretApproval({
			toolName: 'run_in_terminal',
			answer: noul(0.1),
			unavailable: false,
			approvalThreshold: 0.7,
			requireEditApproval: false,
			requireTerminalApproval: true,
		});
		assert.equal(verdict.action, 'prompt');
	});

	it('keys approval questions so the loop can look them up', () => {
		const request = buildApprovalRequest([
			{ id: 'call-1', name: 'integrity_apply_patch', input: { path: 'main.py' } },
		]);
		assert.ok(request);
		assert.ok(request.questions[approvalQuestionId('call-1', 0)]);
	});
});

describe('interpretCompletion', () => {
	it('exits only on a confident complete', () => {
		assert.deepEqual(interpretCompletion({
			answer: choice('complete', 0.6),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		}), { action: 'exit', unavailable: false });
	});

	it('continues when complete is below the confidence threshold', () => {
		const decision = interpretCompletion({
			answer: choice('complete', 0.59),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(decision.action, 'continue');
		assert.equal(decision.unavailable, false);
		assert.match(decision.message ?? '', /low confidence/);
	});

	it('continues for verify_more and incomplete', () => {
		for (const status of ['verify_more', 'incomplete']) {
			const decision = interpretCompletion({
				answer: choice(status, 0.99),
				unavailable: false,
				completionConfidence: 0.6,
				priorUnavailable: false,
			});
			assert.equal(decision.action, 'continue');
			assert.match(decision.message ?? '', new RegExp(status));
		}
	});

	it('continues once when Jev does not answer, then stops', () => {
		const first = interpretCompletion({
			answer: undefined,
			unavailable: true,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(first.action, 'continue');
		assert.equal(first.unavailable, true);
		assert.equal(first.message, COMPLETION_UNVERIFIED_MESSAGE);

		const second = interpretCompletion({
			answer: undefined,
			unavailable: true,
			completionConfidence: 0.6,
			priorUnavailable: true,
		});
		assert.equal(second.action, 'stop');
		assert.equal(second.message, COMPLETION_BLOCKED_MESSAGE);
	});
});
