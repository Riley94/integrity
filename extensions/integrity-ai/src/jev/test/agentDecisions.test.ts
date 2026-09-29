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
	buildApprovalRequest,
	buildRetrievalRequest,
	buildRoutingRequest,
	formatRetrievedChunks,
	interpretApproval,
	interpretCompletion,
	interpretRetrieval,
	interpretRouting,
	isMutatingTool,
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
