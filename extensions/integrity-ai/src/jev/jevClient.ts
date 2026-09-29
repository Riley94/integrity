/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Host-owned client for the Jev System One API.
 * Jev returns typed decisions; it does not write code or call tools.
 */

/**
 * Hosted System One API root. `thejevai.com` is the public playground and
 * rejects TypeSafe API keys with 401, so it must not be used as the default.
 */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/** Initial request plus two retries for 429 and 529. */
const MAX_ATTEMPTS = 3;

const RETRY_STATUSES = new Set([429, 529]);

export class JevUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JevUnavailable';
	}
}

export function isJevUnavailable(err: unknown): err is JevUnavailable {
	return err instanceof JevUnavailable;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

export interface JevClientConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

/** Text, a JSON object, or an array of text. Image and audio are not accepted. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
	type: 'choice';
	instructions: string | Record<string, unknown>;
	criteria: Record<string, string>;
}

export interface NoulQuestion {
	type: 'noul';
	instructions: string | Record<string, unknown>;
	criteria?: { true?: string; false?: string };
}

export type JevQuestion = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: 'choice';
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface NoulAnswer {
	type: 'noul';
	noul: number;
}

export type JevAnswer = ChoiceAnswer | NoulAnswer;

export interface JevEvaluateResult {
	model: string;
	answers: Record<string, JevAnswer>;
}

export interface EvaluateOptions {
	signal?: AbortSignal;
	fetch?: typeof fetch;
	/** Injectable so tests do not wait on retry backoff. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Evaluate one state against a batch of typed questions.
 *
 * @throws {JevUnavailable} when the key is missing, the response is invalid, or retries are exhausted.
 * Abort errors propagate so a cancelled chat turn is not treated as a Jev failure.
 */
export async function evaluateJev(
	config: JevClientConfig,
	state: JevState,
	questions: Record<string, JevQuestion>,
	options?: EvaluateOptions,
): Promise<JevEvaluateResult> {
	const apiKey = config.apiKey.trim();
	if (!apiKey) {
		throw new JevUnavailable('Jev API key is not set.');
	}

	const fetchImpl = options?.fetch ?? fetch;
	const sleepImpl = options?.sleep ?? defaultSleep;
	const url = `${config.baseUrl.replace(/\/$/, '')}/v1/systemone`;
	const body = JSON.stringify({
		model: config.model,
		state,
		questions,
	});

	let lastStatus = 0;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		throwIfAborted(options?.signal);

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body,
				signal: options?.signal,
				redirect: 'error',
			});
		} catch (err) {
			if (isAbortError(err) || options?.signal?.aborted) {
				throw abortError();
			}
			throw new JevUnavailable(redact(config, 'Jev request failed.'));
		}

		if (response.ok) {
			return parseEvaluateResult(await readJson(response));
		}

		lastStatus = response.status;
		// Drain the body so the connection can be reused. Do not include it in errors.
		await response.text().catch(() => undefined);

		if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
			throw new JevUnavailable(`Jev request failed: ${response.status}`);
		}

		await sleepImpl(200 * (2 ** attempt));
		throwIfAborted(options?.signal);
	}

	throw new JevUnavailable(`Jev request failed: ${lastStatus || 'unknown'}`);
}

function parseEvaluateResult(body: unknown): JevEvaluateResult {
	const payload = unwrapPayload(body);
	const answers = parseAnswers(payload.answers);
	return { model: payload.model, answers };
}

function unwrapPayload(body: unknown): { model: string; answers: unknown } {
	if (!body || typeof body !== 'object') {
		throw new JevUnavailable('Jev response was missing answers.');
	}
	const record = body as Record<string, unknown>;
	const nested = record.result;
	const source = nested && typeof nested === 'object'
		? nested as Record<string, unknown>
		: record;
	if (!source.answers || typeof source.answers !== 'object') {
		throw new JevUnavailable('Jev response was missing answers.');
	}
	const model = typeof source.model === 'string'
		? source.model
		: typeof record.model === 'string'
			? record.model
			: '';
	return { model, answers: source.answers };
}

function parseAnswers(raw: unknown): Record<string, JevAnswer> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new JevUnavailable('Jev response was missing answers.');
	}
	const answers: Record<string, JevAnswer> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		answers[key] = parseAnswer(value);
	}
	return answers;
}

function parseAnswer(value: unknown): JevAnswer {
	if (!value || typeof value !== 'object') {
		throw new JevUnavailable('Jev response included an invalid answer.');
	}
	const record = value as Record<string, unknown>;
	if (record.type === 'noul') {
		if (typeof record.noul !== 'number' || !Number.isFinite(record.noul)) {
			throw new JevUnavailable('Jev response included an invalid answer.');
		}
		return { type: 'noul', noul: record.noul };
	}
	if (record.type === 'choice') {
		if (typeof record.choice !== 'string' || !record.choice) {
			throw new JevUnavailable('Jev response included an invalid answer.');
		}
		if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) {
			throw new JevUnavailable('Jev response included an invalid answer.');
		}
		const probabilities = record.probabilities;
		if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
			throw new JevUnavailable('Jev response included an invalid answer.');
		}
		const parsed: Record<string, number> = {};
		for (const [option, probability] of Object.entries(probabilities as Record<string, unknown>)) {
			if (typeof probability !== 'number' || !Number.isFinite(probability)) {
				throw new JevUnavailable('Jev response included an invalid answer.');
			}
			parsed[option] = probability;
		}
		return {
			type: 'choice',
			choice: record.choice,
			confidence: record.confidence,
			probabilities: parsed,
		};
	}
	throw new JevUnavailable('Jev response included an invalid answer.');
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new JevUnavailable('Jev response was missing answers.');
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortError();
	}
}

function abortError(): Error {
	const err = new Error('The operation was aborted');
	err.name = 'AbortError';
	return err;
}

function redact(config: JevClientConfig, message: string): string {
	const key = config.apiKey.trim();
	if (key && message.includes(key)) {
		return message.split(key).join('[redacted]');
	}
	return message;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
