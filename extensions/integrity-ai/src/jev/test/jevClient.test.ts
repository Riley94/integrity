/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JevUnavailable, JEV_DEFAULT_BASE_URL, evaluateJev, isJevUnavailable } from '../jevClient';

const config = {
	apiKey: 'sk_test_secret',
	baseUrl: `${JEV_DEFAULT_BASE_URL}/`,
	model: 'jev-latest',
};

const questions = {
	is_urgent: {
		type: 'noul' as const,
		instructions: 'Does this convey urgency?',
	},
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('evaluateJev', () => {
	it('posts the model, state, and questions with a bearer token', async () => {
		let seenUrl = '';
		let seenInit: RequestInit | undefined;
		const result = await evaluateJev(config, 'payouts are failing', questions, {
			sleep: async () => undefined,
			fetch: async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return jsonResponse(200, {
					model: 'jev-1.13.0',
					answers: { is_urgent: { type: 'noul', noul: 0.95 } },
				});
			},
		});

		assert.equal(seenUrl, 'https://api.typesafe.ai/v1/systemone');
		assert.equal(seenInit?.method, 'POST');
		assert.equal((seenInit?.headers as Record<string, string>).Authorization, 'Bearer sk_test_secret');
		const body = JSON.parse(String(seenInit?.body));
		assert.equal(body.model, 'jev-latest');
		assert.equal(body.state, 'payouts are failing');
		assert.equal(body.questions.is_urgent.type, 'noul');
		assert.equal(result.model, 'jev-1.13.0');
		assert.deepEqual(result.answers.is_urgent, { type: 'noul', noul: 0.95 });
	});

	it('accepts answers nested under result', async () => {
		const result = await evaluateJev(config, { task: 'review' }, {
			status: {
				type: 'choice',
				instructions: 'Done?',
				criteria: { complete: 'yes', incomplete: 'no' },
			},
		}, {
			sleep: async () => undefined,
			fetch: async () => jsonResponse(200, {
				result: {
					model: 'jev-1.13.0',
					answers: {
						status: {
							type: 'choice',
							choice: 'complete',
							confidence: 0.8,
							probabilities: { complete: 0.8, incomplete: 0.2 },
						},
					},
				},
			}),
		});
		assert.equal(result.answers.status.type, 'choice');
	});

	it('does not call the network when the API key is unset', async () => {
		let called = false;
		await assert.rejects(
			() => evaluateJev({ ...config, apiKey: '   ' }, 'state', questions, {
				fetch: async () => {
					called = true;
					return jsonResponse(200, {});
				},
			}),
			(err: unknown) => {
				assert.equal(isJevUnavailable(err), true);
				assert.equal((err as JevUnavailable).message.includes('sk_test_secret'), false);
				return true;
			},
		);
		assert.equal(called, false);
	});

	it('retries 429 and then succeeds', async () => {
		let calls = 0;
		const result = await evaluateJev(config, 'state', questions, {
			sleep: async () => undefined,
			fetch: async () => {
				calls++;
				if (calls === 1) {
					return new Response('slow down', { status: 429 });
				}
				return jsonResponse(200, {
					model: 'jev-1.13.0',
					answers: { is_urgent: { type: 'noul', noul: 0.2 } },
				});
			},
		});
		assert.equal(calls, 2);
		assert.equal(result.answers.is_urgent.type, 'noul');
	});

	it('fails after two retries on 429 and does not retry 401 or 422', async () => {
		let limited = 0;
		await assert.rejects(
			() => evaluateJev(config, 'state', questions, {
				sleep: async () => undefined,
				fetch: async () => {
					limited++;
					return new Response('slow down', { status: 429 });
				},
			}),
			(err: unknown) => isJevUnavailable(err) && (err as Error).message === 'Jev request failed: 429',
		);
		assert.equal(limited, 3);

		for (const status of [401, 422]) {
			let calls = 0;
			await assert.rejects(
				() => evaluateJev(config, 'state', questions, {
					sleep: async () => undefined,
					fetch: async () => {
						calls++;
						return new Response('no', { status });
					},
				}),
				(err: unknown) => {
					assert.equal(isJevUnavailable(err), true);
					assert.equal((err as Error).message.includes(config.apiKey), false);
					return true;
				},
			);
			assert.equal(calls, 1);
		}
	});

	it('retries 529 the same way as 429', async () => {
		let calls = 0;
		await assert.rejects(
			() => evaluateJev(config, 'state', questions, {
				sleep: async () => undefined,
				fetch: async () => {
					calls++;
					return new Response('overloaded', { status: 529 });
				},
			}),
			(err: unknown) => isJevUnavailable(err) && (err as Error).message === 'Jev request failed: 529',
		);
		assert.equal(calls, 3);
	});

	it('defaults to the hosted System One API, not the playground', () => {
		assert.equal(JEV_DEFAULT_BASE_URL, 'https://api.typesafe.ai');
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			contributes: { configuration: { properties: Record<string, { default?: string }> } };
		};
		assert.equal(
			pkg.contributes.configuration.properties['integrity.ai.jev.baseUrl'].default,
			JEV_DEFAULT_BASE_URL,
		);
	});
});
