/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEFAULT_SWEBENCH_MODEL_ID,
	SWEBENCH_ENV,
	SWEBENCH_MODEL_VENDOR,
	approvalFloors,
	benchmarkChatOpenArgs,
	benchmarkStatus,
	isSweBenchBenchmark,
	shouldDeclineOllamaInstall,
	shouldRunOnboarding,
} from '../benchmarkMode';

describe('isSweBenchBenchmark', () => {
	it('is on only when the runner sets the env to 1', () => {
		assert.equal(isSweBenchBenchmark({ [SWEBENCH_ENV]: '1' }), true);
		assert.equal(isSweBenchBenchmark({}), false);
		assert.equal(isSweBenchBenchmark({ [SWEBENCH_ENV]: 'true' }), false);
	});
});

describe('approvalFloors', () => {
	it('clears both floors during a smoke run', () => {
		assert.deepEqual(approvalFloors({
			requireEditApproval: true,
			requireTerminalApproval: true,
		}, true), {
			requireEditApproval: false,
			requireTerminalApproval: false,
		});
	});

	it('passes configured floors through outside a smoke run', () => {
		assert.deepEqual(approvalFloors({
			requireEditApproval: true,
			requireTerminalApproval: false,
		}, false), {
			requireEditApproval: true,
			requireTerminalApproval: false,
		});
	});
});

describe('shouldRunOnboarding', () => {
	it('skips the welcome modal during a smoke run without treating it as seen', () => {
		assert.equal(shouldRunOnboarding(false, true), false);
		assert.equal(shouldRunOnboarding(false, false), true);
		assert.equal(shouldRunOnboarding(true, false), false);
	});
});

describe('shouldDeclineOllamaInstall', () => {
	it('declines the install confirm only during a smoke run', () => {
		assert.equal(shouldDeclineOllamaInstall(true), true);
		assert.equal(shouldDeclineOllamaInstall(false), false);
	});
});

describe('benchmarkChatOpenArgs', () => {
	it('submits the problem statement in Agent mode and waits for the turn', () => {
		const prompt = 'Fix the off-by-one in the parser.';
		assert.deepEqual(benchmarkChatOpenArgs(prompt, DEFAULT_SWEBENCH_MODEL_ID), {
			mode: 'agent',
			query: prompt,
			blockOnResponse: true,
			modelSelector: {
				vendor: SWEBENCH_MODEL_VENDOR,
				id: DEFAULT_SWEBENCH_MODEL_ID,
			},
		});
	});
});

describe('benchmarkStatus', () => {
	it('omits message when the turn finished cleanly', () => {
		assert.deepEqual(benchmarkStatus('completed'), { outcome: 'completed' });
	});

	it('keeps the error message', () => {
		assert.deepEqual(benchmarkStatus('error', 'no model'), {
			outcome: 'error',
			message: 'no model',
		});
	});
});
