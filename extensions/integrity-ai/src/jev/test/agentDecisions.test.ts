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
	toolSurfaceQuestionId,
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

	it('keeps every tool whose noul reaches the threshold', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				integrity_read_file: noul(0.2),
				integrity_apply_patch: noul(0.8),
				run_in_terminal: noul(0.61),
			},
		}), ['integrity_apply_patch', 'run_in_terminal']);
	});

	it('keeps a tool when its noul equals the threshold', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				integrity_read_file: noul(0.6),
				integrity_apply_patch: noul(0.59),
				run_in_terminal: noul(0),
			},
		}), ['integrity_read_file']);
	});

	it('returns no tools when every noul is below the threshold', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				integrity_read_file: noul(0.59),
				integrity_apply_patch: noul(0.1),
				run_in_terminal: noul(0.59),
			},
		}), []);
	});

	it('ignores a score for a tool that was not offered', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				browse: noul(0.99),
				integrity_read_file: noul(0.9),
			},
		}), ['integrity_read_file']);
	});

	it('returns no tools when Jev is unavailable', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: true,
			answers: undefined,
		}), []);
	});

	it('withholds a tool whose answer is missing or not a noul', () => {
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {
				integrity_read_file: choice('integrity_read_file', 0.9),
				integrity_apply_patch: noul(0.9),
			},
		}), ['integrity_apply_patch']);
		assert.deepEqual(interpretToolSurface({
			...base,
			unavailable: false,
			answers: {},
		}), []);
	});
});

describe('explainToolSurface', () => {
	const names = surfaceTools.map(tool => tool.name);
	const offered = offeredToolChoices(names);

	it('records every selected tool and withholds the rest', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				integrity_read_file: noul(0.82),
				integrity_apply_patch: noul(0.71),
				run_in_terminal: noul(0.08),
			},
		});
		assert.deepEqual(trace.toolNames, ['integrity_read_file', 'integrity_apply_patch']);
		assert.equal(trace.text, [
			'Jev tools',
			'offered: integrity_read_file, integrity_apply_patch, run_in_terminal',
			'integrity_read_file: 0.82',
			'integrity_apply_patch: 0.71',
			'run_in_terminal: 0.08',
			'threshold: 0.60',
			'decision: selected integrity_read_file, integrity_apply_patch',
			'tools: integrity_read_file, integrity_apply_patch',
			'withheld: run_in_terminal',
		].join('\n'));
	});

	it('stays text-only when every noul is below the threshold', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				integrity_read_file: noul(0.59),
				integrity_apply_patch: noul(0.1),
				run_in_terminal: noul(0.2),
			},
		});
		assert.deepEqual(trace.toolNames, []);
		assert.match(trace.text, /integrity_read_file: 0.59/);
		assert.match(trace.text, /decision: text only \(no tool reached 0.60\)/);
		assert.match(trace.text, /tools: none/);
		assert.match(trace.text, /withheld: integrity_read_file, integrity_apply_patch, run_in_terminal/);
	});

	it('says when Jev did not answer', () => {
		const trace = explainToolSurface({
			unavailable: true,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: undefined,
		});
		assert.deepEqual(trace.toolNames, []);
		assert.match(trace.text, /decision: text only \(Jev did not answer\)/);
		assert.match(trace.text, /threshold: 0.60/);
		assert.match(trace.text, /withheld: integrity_read_file, integrity_apply_patch, run_in_terminal/);
	});

	it('says when an answer is missing or not a noul and still keeps the others', () => {
		const trace = explainToolSurface({
			unavailable: false,
			offered,
			toolSurfaceConfidence: 0.6,
			toolNames: names,
			answers: {
				integrity_read_file: choice('integrity_read_file', 0.9),
				integrity_apply_patch: noul(0.9),
			},
		});
		assert.deepEqual(trace.toolNames, ['integrity_apply_patch']);
		assert.match(trace.text, /integrity_read_file: not a noul/);
		assert.match(trace.text, /run_in_terminal: missing/);
		assert.match(trace.text, /decision: selected integrity_apply_patch/);
		assert.match(trace.text, /withheld: integrity_read_file, run_in_terminal/);
	});

	it('skips the call when there is nothing to choose', () => {
		const trace = explainToolSurface({
			unavailable: true,
			offered: [],
			toolSurfaceConfidence: 0.6,
			toolNames: [],
			answers: undefined,
		});
		assert.deepEqual(trace.toolNames, []);
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
		assert.match(text, /"integrity_read_file"/);
		assert.match(text, /"integrity_apply_patch"/);
		assert.match(text, /"run_in_terminal"/);
		assert.ok(text.endsWith('\n\n' + reply));
	});

	it('prints only the reply when no request was sent', () => {
		const reply = describeSkippedToolSurface('no tools were enabled');
		assert.equal(formatJevDebug(undefined, reply), reply);
	});

	it('is off unless the development setting is enabled', () => {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			contributes: { configuration: { properties: Record<string, { default?: boolean | number }> } };
		};
		assert.equal(pkg.contributes.configuration.properties['integrity.ai.jev.debug'].default, false);
		assert.equal(pkg.contributes.configuration.properties['integrity.ai.jev.toolSurfaceConfidence'].default, 0.5);
	});
});

describe('rejectionForUnselectedTool', () => {
	it('rejects every call on a text-only turn', () => {
		assert.match(rejectionForUnselectedTool('vscode_askQuestions', []) ?? '', /no tool/);
	});

	it('rejects a call other than the selected tools', () => {
		assert.match(
			rejectionForUnselectedTool('vscode_askQuestions', ['integrity_read_file', 'integrity_apply_patch']) ?? '',
			/only call integrity_read_file, integrity_apply_patch/,
		);
	});

	it('allows each selected tool', () => {
		const selected = ['integrity_create_file', 'integrity_apply_patch'];
		assert.equal(rejectionForUnselectedTool('integrity_create_file', selected), undefined);
		assert.equal(rejectionForUnselectedTool('integrity_apply_patch', selected), undefined);
	});
});

describe('buildToolSurfaceRequest', () => {
	it('asks one noul per tool in a single request', () => {
		const request = buildToolSurfaceRequest('fix the bug', 'agent', surfaceTools);
		assert.ok(request);
		assert.deepEqual(Object.keys(request.questions), surfaceTools.map(tool => tool.name));
		for (const tool of surfaceTools) {
			const question = request.questions[toolSurfaceQuestionId(tool.name)];
			assert.equal(question.type, 'noul');
			if (question.type === 'noul') {
				assert.match(question.instructions, new RegExp(`Is ${tool.name} required`));
				assert.equal(question.criteria?.true, 'This tool is needed to complete the task');
				assert.equal(question.criteria?.false, 'This tool is not needed to complete the task');
			}
		}
		const state = request.state as { mode: string; tools: { name: string; description: string }[] };
		assert.equal(state.mode, 'agent');
		assert.deepEqual(state.tools.map(tool => tool.name), surfaceTools.map(tool => tool.name));
		assert.equal(state.tools[0].description, 'Read a file');
	});

	it('does not build a request when there are no tools', () => {
		assert.equal(buildToolSurfaceRequest('hello', 'agent', []), undefined);
		assert.deepEqual(offeredToolChoices([]), []);
	});

	it('drops blank and duplicate tool names', () => {
		assert.deepEqual(offeredToolChoices(['', 'integrity_read_file', 'integrity_read_file', 'integrity_apply_patch']), [
			'integrity_read_file',
			'integrity_apply_patch',
		]);
		const request = buildToolSurfaceRequest('hello', 'agent', [
			{ name: 'integrity_read_file', description: 'first' },
			{ name: '', description: 'blank' },
			{ name: 'integrity_read_file', description: 'second' },
		]);
		assert.ok(request);
		assert.deepEqual(Object.keys(request.questions), ['integrity_read_file']);
		const state = request.state as { tools: { description: string }[] };
		assert.equal(state.tools.length, 1);
		assert.equal(state.tools[0].description, 'first');
	});

	it('clips long tool descriptions', () => {
		const request = buildToolSurfaceRequest('hello', 'ask', [
			{ name: 'integrity_read_file', description: 'x'.repeat(500) },
		]);
		assert.ok(request);
		const state = request.state as { tools: { description: string }[] };
		assert.equal(state.tools[0].description.length, 401);
		assert.ok(state.tools[0].description.endsWith('…'));
		assert.equal(request.questions.integrity_read_file.type, 'noul');
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
		const request = buildCompletionRequest('fix the test', 'done', [
			{ name: 'integrity_replace_string', input: { path: 'a.ts', oldText: 'a', newText: 'b' } },
		]);
		const trace = explainCompletion({
			answer: noul(0.2),
			unavailable: false,
			completionConfidence: 0.6,
			priorUnavailable: false,
		});
		const text = formatJevDebug(request, trace.text);
		assert.match(text, /"task": "fix the test"/);
		assert.match(text, /"assistantText": "done"/);
		assert.match(text, /"name": "integrity_replace_string"/);
		assert.match(text, /"path": "a.ts"/);
		assert.match(text, /"type": "noul"/);
		assert.match(text, /Is the task complete\?/);
		assert.match(text, /status: incomplete/);
		assert.ok(text.endsWith('\n\n' + trace.text));
	});
});

describe('buildCompletionRequest', () => {
	it('sends an empty tool call list when the turn has not called a tool', () => {
		const request = buildCompletionRequest('fix the test', 'done');
		const state = request.state as { toolCalls: unknown[] };
		assert.deepEqual(state.toolCalls, []);
	});

	it('includes the tool call name and arguments', () => {
		const request = buildCompletionRequest('fix the test', 'done', [
			{ name: 'integrity_replace_string', input: { path: 'a.ts', oldText: 'a', newText: 'b' } },
		]);
		const state = request.state as { toolCalls: Array<{ name: string; arguments: { path: string; newText: string } }> };
		assert.equal(state.toolCalls.length, 1);
		assert.equal(state.toolCalls[0].name, 'integrity_replace_string');
		assert.equal(state.toolCalls[0].arguments.path, 'a.ts');
		assert.equal(state.toolCalls[0].arguments.newText, 'b');
	});

	it('clips a tool call argument that exceeds the per-call limit', () => {
		const request = buildCompletionRequest('task', 'done', [
			{ name: 'integrity_create_file', input: { content: 'y'.repeat(5000) } },
		]);
		const state = request.state as { toolCalls: Array<{ arguments: string }> };
		assert.equal(typeof state.toolCalls[0].arguments, 'string');
		assert.ok(state.toolCalls[0].arguments.endsWith('…'));
		assert.ok(state.toolCalls[0].arguments.length < 5000);
	});

	it('keeps the latest tool calls when the list exceeds the state budget', () => {
		const body = 'x'.repeat(3000);
		const calls = Array.from({ length: 5 }, (_, index) => ({
			name: `tool_${index}`,
			input: { body },
		}));
		const request = buildCompletionRequest('task', 'done', calls);
		const state = request.state as { toolCalls: Array<{ name: string }> };
		assert.ok(state.toolCalls.length >= 1);
		assert.ok(state.toolCalls.length < calls.length);
		assert.equal(state.toolCalls.at(-1)?.name, 'tool_4');
		assert.equal(state.toolCalls.some(call => call.name === 'tool_0'), false);
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
