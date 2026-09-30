/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	COMPLETION_BLOCKED_MESSAGE,
	COMPLETION_UNVERIFIED_MESSAGE,
	approvalQuestionId,
	blockedMutatingToolMessage,
	TOOL_SURFACE_NONE_QUESTION,
	TOOL_SURFACE_QUESTION,
	buildApprovalRequest,
	buildCompletionRequest,
	buildRetrievalRequest,
	buildToolSurfaceRequest,
	describeSkippedToolSurface,
	explainCompletion,
	explainToolSurface,
	formatJevDebug,
	formatRetrievedChunks,
	interpretApproval,
	interpretCompletion,
	interpretRetrieval,
	interpretToolSurface,
	isMutatingTool,
	offeredToolChoices,
	rejectionForUnselectedTool,
	retrievalQuestionId,
} from '../agentDecisions';
import type { JevAnswer } from '../jevClient';

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

const surfaceTools = [
	{ name: 'integrity_read_file', description: 'Read a file' },
	{ name: 'integrity_apply_patch', description: 'Apply a patch' },
	{ name: 'run_in_terminal', description: 'Run a command' },
];

describe('interpretToolSurface', () => {
	const offered = offeredToolChoices(surfaceTools.map(tool => tool.name));
	const base = {
		offered,
		toolSurfaceConfidence: 0.6,
	};

	it('selects a confident offered tool when none-suitable is low', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('integrity_read_file', 0.6),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.59),
			},
		}), 'integrity_read_file');
	});

	it('returns no tool when Jev chooses reply', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('reply', 0.9),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.1),
			},
		}), undefined);
	});

	it('returns no tool on low confidence', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('integrity_read_file', 0.59),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.1),
			},
		}), undefined);
	});

	it('returns no tool when none of the options are suitable', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('run_in_terminal', 0.9),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.6),
			},
		}), undefined);
	});

	it('returns no tool when the chosen id was not offered', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('browse', 0.99),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0),
			},
		}), undefined);
	});

	it('returns no tool when Jev is unavailable', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: true,
			answers: undefined,
		}), undefined);
	});

	it('returns no tool when the answer shape is wrong', () => {
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: noul(0.9),
				[TOOL_SURFACE_NONE_QUESTION]: choice('integrity_read_file', 0.9),
			},
		}), undefined);
		assert.equal(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('integrity_read_file', 0.9),
			},
		}), undefined);
	});
});

describe('explainToolSurface', () => {
	const names = surfaceTools.map(tool => tool.name);
	const offered = offeredToolChoices(names);

	it('records the one selected tool and withholds the rest', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: {
					type: 'choice',
					choice: 'integrity_read_file',
					confidence: 0.82,
					probabilities: { reply: 0.02, integrity_read_file: 0.82, integrity_apply_patch: 0.08, run_in_terminal: 0.08 },
				},
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.05),
			},
		});
		assert.equal(trace.toolName, 'integrity_read_file');
		assert.equal(trace.text, [
			'Jev tools',
			'offered: reply, integrity_read_file, integrity_apply_patch, run_in_terminal',
			'choice: integrity_read_file',
			'confidence: 0.82',
			'threshold: 0.60',
			'probabilities: reply 0.02, integrity_read_file 0.82, integrity_apply_patch 0.08, run_in_terminal 0.08',
			'none suitable: 0.05',
			'decision: selected integrity_read_file',
			'tool: integrity_read_file',
			'withheld: integrity_apply_patch, run_in_terminal',
		].join('\n'));
	});

	it('stays text-only when confidence is below the threshold', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('integrity_read_file', 0.59),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.1),
			},
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /choice: integrity_read_file/);
		assert.match(trace.text, /decision: text only \(confidence 0.59 is below 0.60\)/);
		assert.match(trace.text, /tool: none/);
	});

	it('stays text-only when none suitable is too high', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('run_in_terminal', 0.9),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.6),
			},
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /decision: text only \(none suitable 0.60 is at or above 0.60\)/);
	});

	it('says when Jev did not answer', () => {
		const trace = explainToolSurface({
			unavailable: true,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: undefined,
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /decision: text only \(Jev did not answer\)/);
		assert.match(trace.text, /withheld: integrity_read_file, integrity_apply_patch, run_in_terminal/);
	});

	it('says when the answer shape is wrong', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: noul(0.9),
				[TOOL_SURFACE_NONE_QUESTION]: choice('integrity_read_file', 0.9),
			},
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /decision: text only \(answer was missing a choice or a none-suitable score\)/);
	});

	it('says when the chosen id was not offered', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('browse', 0.99),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0),
			},
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /decision: text only \(choice browse was not offered\)/);
	});

	it('records a reply as text only and withholds every tool', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				[TOOL_SURFACE_QUESTION]: choice('reply', 0.9),
				[TOOL_SURFACE_NONE_QUESTION]: noul(0.1),
			},
		});
		assert.equal(trace.toolName, undefined);
		assert.match(trace.text, /decision: text only \(Jev chose reply\)/);
		assert.match(trace.text, /tool: none/);
		assert.match(trace.text, /withheld: integrity_read_file, integrity_apply_patch, run_in_terminal/);
	});

	it('skips the call when there is nothing to choose', () => {
		const trace = explainToolSurface({
			unavailable: true,
			offered: [],
			toolSurfaceConfidence: 0.6,
			toolNames: [],
			answers: undefined,
		});
		assert.equal(trace.toolName, undefined);
		assert.equal(trace.text, 'Jev tools\ndecision: text only (nothing to choose)');
	});
});

describe('describeSkippedToolSurface', () => {
	it('names why the tool was not requested', () => {
		assert.equal(
			describeSkippedToolSurface('no tools were enabled'),
			'Jev tools\ndecision: skipped (no tools were enabled)',
		);
	});
});

describe('formatJevDebug', () => {
	it('prints the state and questions ahead of the reply', () => {
		const request = buildToolSurfaceRequest('fix the test', 'agent', surfaceTools);
		assert.ok(request);
		const reply = 'Jev tools\ndecision: selected integrity_read_file';
		const text = formatJevDebug(request, reply);
		assert.match(text, /^Jev request\nstate:\n\{/);
		assert.match(text, /"task": "fix the test"/);
		assert.match(text, /"mode": "agent"/);
		assert.match(text, /questions:\n\{/);
		assert.match(text, /"surface"/);
		assert.match(text, /"none_suitable"/);
		assert.ok(text.endsWith('\n\n' + reply));
	});

	it('prints only the reply when no request was sent', () => {
		const reply = describeSkippedToolSurface('no tools were enabled');
		assert.equal(formatJevDebug(undefined, reply), reply);
	});

	it('is off unless the development setting is enabled', () => {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			contributes: { configuration: { properties: Record<string, { default?: boolean }> } };
		};
		assert.equal(pkg.contributes.configuration.properties['integrity.ai.jev.debug'].default, false);
	});
});

describe('rejectionForUnselectedTool', () => {
	it('rejects every call on a text-only turn', () => {
		assert.match(rejectionForUnselectedTool('vscode_askQuestions', undefined) ?? '', /no tool/);
	});

	it('rejects a call other than the selected tool', () => {
		assert.match(
			rejectionForUnselectedTool('vscode_askQuestions', 'integrity_read_file') ?? '',
			/only call integrity_read_file/,
		);
	});

	it('allows the selected tool', () => {
		assert.equal(rejectionForUnselectedTool('integrity_read_file', 'integrity_read_file'), undefined);
	});
});

describe('buildToolSurfaceRequest', () => {
	it('offers reply and every tool, with descriptions as criteria', () => {
		const request = buildToolSurfaceRequest('fix the bug', 'agent', surfaceTools);
		assert.ok(request);
		const surface = request.questions[TOOL_SURFACE_QUESTION];
		assert.equal(surface.type, 'choice');
		if (surface.type === 'choice') {
			assert.deepEqual(Object.keys(surface.criteria), ['reply', 'integrity_read_file', 'integrity_apply_patch', 'run_in_terminal']);
			assert.equal(surface.criteria.integrity_read_file, 'Read a file');
		}
		assert.equal(request.questions[TOOL_SURFACE_NONE_QUESTION].type, 'noul');
		const state = request.state as { mode: string; tools: { name: string; description: string }[] };
		assert.equal(state.mode, 'agent');
		assert.deepEqual(state.tools.map(tool => tool.name), surfaceTools.map(tool => tool.name));
	});

	it('does not build a request when there are no tools', () => {
		assert.equal(buildToolSurfaceRequest('hello', 'agent', []), undefined);
		assert.deepEqual(offeredToolChoices([]), []);
	});

	it('clips long tool descriptions', () => {
		const request = buildToolSurfaceRequest('hello', 'ask', [
			{ name: 'integrity_read_file', description: 'x'.repeat(500) },
		]);
		assert.ok(request);
		const state = request.state as { tools: { description: string }[] };
		assert.equal(state.tools[0].description.length, 401);
		assert.ok(state.tools[0].description.endsWith('…'));
		const surface = request.questions[TOOL_SURFACE_QUESTION];
		assert.equal(surface.type, 'choice');
		if (surface.type === 'choice') {
			assert.equal(surface.criteria.integrity_read_file.length, 401);
		}
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

describe('explainCompletion', () => {
	it('records a complete Noul as an exit', () => {
		const trace = explainCompletion({
			answer: noul(0.82),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(trace.decision.action, 'exit');
		assert.match(trace.text, /noul: 0.82/);
		assert.match(trace.text, /threshold: 0.60/);
		assert.match(trace.text, /status: complete/);
		assert.match(trace.text, /decision: exit/);
	});

	it('records an incomplete Noul as continue', () => {
		const trace = explainCompletion({
			answer: noul(0.59),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(trace.decision.action, 'continue');
		assert.match(trace.text, /noul: 0.59/);
		assert.match(trace.text, /status: incomplete/);
		assert.match(trace.text, /decision: continue/);
		assert.match(trace.text, /incomplete/);
	});

	it('says when Jev did not answer', () => {
		const trace = explainCompletion({
			answer: undefined,
			unavailable: true,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(trace.decision.action, 'continue');
		assert.match(trace.text, /decision: continue \(Jev did not answer\)/);
		assert.equal(trace.text.includes('status:'), false);
	});

	it('prints the completion state and the Noul question ahead of the reply', () => {
		const request = buildCompletionRequest('fix the test', 'done');
		const trace = explainCompletion({
			answer: noul(0.2),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		const text = formatJevDebug(request, trace.text);
		assert.match(text, /"task": "fix the test"/);
		assert.match(text, /"assistantText": "done"/);
		assert.match(text, /"type": "noul"/);
		assert.match(text, /Is the task complete\?/);
		assert.match(text, /status: incomplete/);
		assert.ok(text.endsWith('\n\n' + trace.text));
	});
});

describe('interpretCompletion', () => {
	it('exits when the Noul is at or above the threshold', () => {
		assert.deepEqual(interpretCompletion({
			answer: noul(0.6),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		}), { action: 'exit', unavailable: false });
	});

	it('continues when the Noul is below the threshold', () => {
		const decision = interpretCompletion({
			answer: noul(0.59),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(decision.action, 'continue');
		assert.equal(decision.unavailable, false);
		assert.match(decision.message ?? '', /incomplete/);
	});

	it('treats a choice answer as a missing completion score', () => {
		const decision = interpretCompletion({
			answer: choice('complete', 0.99),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		assert.equal(decision.action, 'continue');
		assert.equal(decision.unavailable, true);
		assert.equal(decision.message, COMPLETION_UNVERIFIED_MESSAGE);
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
