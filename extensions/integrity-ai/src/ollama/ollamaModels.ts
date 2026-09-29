/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { normalizeOllamaBaseUrl } from './ollamaServer';
import { streamLines } from '../providers/types';

const DEFAULT_REGISTRY = 'registry.ollama.ai';
const DEFAULT_NAMESPACE = 'library';
const DEFAULT_TAG = 'latest';
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json';

/**
 * Parsed Ollama model reference (`namespace/repo:tag` on a registry host).
 */
export interface OllamaModelRef {
	registry: string;
	namespace: string;
	repository: string;
	tag: string;
}

export interface PullProgress {
	completed: number;
	total: number;
	status: string;
}

export interface EnsureOllamaModelDeps {
	ensureServer: () => Promise<boolean>;
	listInstalled: (baseUrl: string) => Promise<string[]>;
	lookupSize: (model: string) => Promise<number | undefined>;
	pull: (baseUrl: string, model: string, onProgress: (progress: PullProgress) => void, signal: AbortSignal) => Promise<void>;
	promptInstall: (model: string, sizeBytes: number | undefined) => Promise<boolean>;
	withProgress: <T>(title: string, task: (report: (message: string) => void, signal: AbortSignal) => Promise<T>) => Promise<T>;
	showError: (message: string) => void;
}

export type EnsureOllamaModelResult =
	| { status: 'already-installed' }
	| { status: 'installed' }
	| { status: 'declined' }
	| { status: 'unavailable' }
	| { status: 'cancelled' }
	| { status: 'failed'; message: string };

interface RegistryLayer {
	digest?: string;
	size?: number;
	mediaType?: string;
}

interface RegistryManifest {
	mediaType?: string;
	config?: RegistryLayer;
	layers?: RegistryLayer[];
	manifests?: Array<{
		digest?: string;
		mediaType?: string;
		platform?: { architecture?: string; os?: string };
	}>;
}

interface PullEvent {
	status?: string;
	digest?: string;
	total?: number;
	completed?: number;
	error?: string;
}

/**
 * Split an Ollama model name into registry, namespace, repository, and tag.
 *
 * Bare names (`llama3`) resolve to `library/llama3:latest` on registry.ollama.ai.
 */
export function parseOllamaModelRef(raw: string): OllamaModelRef {
	let name = raw.trim();
	const digestAt = name.lastIndexOf('@');
	if (digestAt >= 0) {
		name = name.slice(0, digestAt);
	}

	let tag = DEFAULT_TAG;
	const lastColon = name.lastIndexOf(':');
	const lastSlash = name.lastIndexOf('/');
	if (lastColon > lastSlash) {
		tag = name.slice(lastColon + 1);
		name = name.slice(0, lastColon);
	}

	const parts = name.split('/').filter(Boolean);
	if (parts.length <= 1) {
		return {
			registry: DEFAULT_REGISTRY,
			namespace: DEFAULT_NAMESPACE,
			repository: parts[0] ?? name,
			tag,
		};
	}
	if (parts.length === 2) {
		return {
			registry: DEFAULT_REGISTRY,
			namespace: parts[0],
			repository: parts[1],
			tag,
		};
	}

	return {
		registry: parts[0],
		namespace: parts[1],
		repository: parts.slice(2).join('/'),
		tag,
	};
}

/**
 * Canonical `namespace/repo:tag` (library namespace omitted) for comparisons and cache keys.
 */
export function normalizeOllamaModelName(name: string): string {
	const ref = parseOllamaModelRef(name);
	const nsRepo = ref.namespace === DEFAULT_NAMESPACE
		? ref.repository
		: `${ref.namespace}/${ref.repository}`;
	return `${nsRepo}:${ref.tag}`;
}

export function ollamaModelNamesMatch(a: string, b: string): boolean {
	const left = parseOllamaModelRef(a);
	const right = parseOllamaModelRef(b);
	return left.namespace === right.namespace
		&& left.repository === right.repository
		&& left.tag === right.tag;
}

/**
 * Human-readable byte size (1024-based), e.g. `4.7 GB`.
 */
export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return '0 B';
	}
	if (bytes < 1024) {
		return `${Math.round(bytes)} B`;
	}

	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Copy for the install confirmation dialog.
 */
export function installPromptCopy(model: string, sizeBytes: number | undefined): { message: string; detail: string } {
	const message = `Install Ollama model "${model}"?`;
	const detail = typeof sizeBytes === 'number'
		? `This model is not installed. Installing it will use about ${formatByteSize(sizeBytes)} of disk space.`
		: 'This model is not installed. Integrity can pull it from the Ollama library.';
	return { message, detail };
}

export function isOllamaModelInstalled(model: string, installed: readonly string[]): boolean {
	return installed.some(name => ollamaModelNamesMatch(name, model));
}

/**
 * Names reported by a local Ollama `/api/tags` response.
 */
export async function listInstalledOllamaModels(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
	const response = await fetchFn(`${normalizeOllamaBaseUrl(baseUrl)}/api/tags`);
	if (!response.ok) {
		return [];
	}

	const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
	const names = new Set<string>();
	for (const entry of data.models ?? []) {
		if (entry.name) {
			names.add(entry.name);
		}
		if (entry.model) {
			names.add(entry.model);
		}
	}
	return [...names];
}

export interface LookupOllamaModelSizeOptions {
	fetchFn?: typeof fetch;
	preferredArch?: string;
	preferredOs?: string;
}

/**
 * Download size for a model that may not be installed yet, from the Ollama registry manifest.
 *
 * @returns Size in bytes, or `undefined` when the registry cannot be reached or has no size.
 */
export async function lookupOllamaModelSize(
	model: string,
	options: LookupOllamaModelSizeOptions = {},
): Promise<number | undefined> {
	const fetchFn = options.fetchFn ?? fetch;
	const preferredArch = options.preferredArch ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
	const preferredOs = options.preferredOs ?? 'linux';
	const ref = parseOllamaModelRef(model);

	try {
		const manifest = await fetchRegistryManifest(ref, ref.tag, fetchFn);
		return await resolveManifestSize(ref, manifest, fetchFn, preferredArch, preferredOs, 0);
	} catch {
		return undefined;
	}
}

export interface PullOllamaModelOptions {
	fetchFn?: typeof fetch;
	onProgress?: (progress: PullProgress) => void;
	signal?: AbortSignal;
}

/**
 * Stream `POST /api/pull` until Ollama reports success.
 */
export async function pullOllamaModel(
	baseUrl: string,
	model: string,
	options: PullOllamaModelOptions = {},
): Promise<void> {
	const fetchFn = options.fetchFn ?? fetch;
	const response = await fetchFn(`${normalizeOllamaBaseUrl(baseUrl)}/api/pull`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: model, stream: true }),
		signal: options.signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(text || `Ollama pull failed: ${response.status}`);
	}
	if (!response.body) {
		throw new Error('Ollama pull returned no body');
	}

	const layers = new Map<string, { total: number; completed: number }>();
	let lastStatus = '';
	let succeeded = false;

	for await (const line of streamLines(response.body)) {
		let event: PullEvent;
		try {
			event = JSON.parse(line) as PullEvent;
		} catch {
			continue;
		}

		if (event.error) {
			throw new Error(event.error);
		}

		if (event.digest) {
			layers.set(event.digest, {
				total: event.total ?? 0,
				completed: event.completed ?? 0,
			});
		}

		lastStatus = event.status ?? lastStatus;
		let completed = 0;
		let total = 0;
		for (const layer of layers.values()) {
			completed += layer.completed;
			total += layer.total;
		}
		options.onProgress?.({ completed, total, status: lastStatus });

		if (event.status === 'success') {
			succeeded = true;
			break;
		}
	}

	if (!succeeded) {
		throw new Error(`Pull of "${model}" did not complete`);
	}
}

/**
 * True when the model is local (already present or just pulled).
 */
export function isOllamaModelReady(result: EnsureOllamaModelResult): boolean {
	return result.status === 'already-installed' || result.status === 'installed';
}

/**
 * Short error shown in chat when the selected Ollama model could not be used.
 */
export function ollamaModelNotReadyMessage(model: string, result: EnsureOllamaModelResult): string {
	switch (result.status) {
		case 'unavailable':
			return 'Ollama is not available. Start it from the Command Palette (Integrity: Start Ollama).';
		case 'failed':
			return `Could not install Ollama model "${model}": ${result.message}`;
		case 'cancelled':
			return `Installation of Ollama model "${model}" was cancelled.`;
		case 'declined':
		default:
			return `Ollama model "${model}" is not installed.`;
	}
}

/**
 * If the selected model is missing, ask to install it (with size) and pull when accepted.
 */
export async function ensureOllamaModelInstalled(
	model: string,
	baseUrl: string,
	deps: EnsureOllamaModelDeps,
): Promise<EnsureOllamaModelResult> {
	if (!await deps.ensureServer()) {
		return { status: 'unavailable' };
	}

	let installed: string[] = [];
	try {
		installed = await deps.listInstalled(baseUrl);
	} catch {
		installed = [];
	}

	if (isOllamaModelInstalled(model, installed)) {
		return { status: 'already-installed' };
	}

	let sizeBytes: number | undefined;
	try {
		sizeBytes = await deps.lookupSize(model);
	} catch {
		sizeBytes = undefined;
	}

	const accepted = await deps.promptInstall(model, sizeBytes);
	if (!accepted) {
		return { status: 'declined' };
	}

	try {
		await deps.withProgress(`Integrity: Installing ${model}`, async (report, signal) => {
			await deps.pull(baseUrl, model, progress => {
				if (progress.total > 0) {
					report(`${progress.status} (${formatByteSize(progress.completed)} / ${formatByteSize(progress.total)})`);
				} else if (progress.status) {
					report(progress.status);
				}
			}, signal);
		});
		return { status: 'installed' };
	} catch (err) {
		if (isAbortError(err)) {
			return { status: 'cancelled' };
		}
		const message = err instanceof Error ? err.message : String(err);
		deps.showError(`Failed to install ${model}: ${message}`);
		return { status: 'failed', message };
	}
}

function isAbortError(err: unknown): boolean {
	return typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'AbortError';
}

function manifestByteSize(manifest: RegistryManifest): number | undefined {
	if (!manifest.layers?.length) {
		return undefined;
	}
	let size = manifest.config?.size ?? 0;
	for (const layer of manifest.layers) {
		size += layer.size ?? 0;
	}
	return size > 0 ? size : undefined;
}

function pickIndexDigest(
	manifests: NonNullable<RegistryManifest['manifests']>,
	preferredArch: string,
	preferredOs: string,
): string | undefined {
	const platformMatch = manifests.find(entry =>
		entry.digest
		&& entry.platform?.architecture === preferredArch
		&& entry.platform?.os === preferredOs,
	);
	if (platformMatch?.digest) {
		return platformMatch.digest;
	}
	return manifests.find(entry => entry.digest)?.digest;
}

async function resolveManifestSize(
	ref: OllamaModelRef,
	manifest: RegistryManifest,
	fetchFn: typeof fetch,
	preferredArch: string,
	preferredOs: string,
	depth: number,
): Promise<number | undefined> {
	const direct = manifestByteSize(manifest);
	if (direct !== undefined) {
		return direct;
	}
	if (depth >= 2 || !manifest.manifests?.length) {
		return undefined;
	}

	const digest = pickIndexDigest(manifest.manifests, preferredArch, preferredOs);
	if (!digest) {
		return undefined;
	}

	const nested = await fetchRegistryManifest(ref, digest, fetchFn);
	return resolveManifestSize(ref, nested, fetchFn, preferredArch, preferredOs, depth + 1);
}

async function fetchRegistryManifest(
	ref: OllamaModelRef,
	reference: string,
	fetchFn: typeof fetch,
): Promise<RegistryManifest> {
	const url = `https://${ref.registry}/v2/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.repository)}/manifests/${encodeURIComponent(reference)}`;
	const response = await fetchFn(url, {
		headers: { Accept: MANIFEST_ACCEPT },
	});
	if (!response.ok) {
		throw new Error(`Registry manifest ${response.status}`);
	}
	return await response.json() as RegistryManifest;
}
