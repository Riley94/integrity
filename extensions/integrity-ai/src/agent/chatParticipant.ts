/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildSystemPrompt } from './agentPrompt';
import { rejectionForMisroutedToolCall } from './browserToolGuard';
import { loadAgentRules, type CodebaseSearchIndex } from './lmTools';
import { extractPathFromInput } from './pathPolicy';
import { inferModeKind, IntegrityToolName, isToolAllowedInMode, type AgentModeKind } from './toolNames';
import { parseModelId } from '../providers/modelId';
import { INTEGRITY_LM_VENDOR } from '../providers/languageModelProvider';
import { ensureOllamaModelReady, isOllamaModelReady, ollamaModelNotReadyMessage } from '../ollama/ensureOllamaModel';
import {
	COMPLETION_BLOCKED_MESSAGE,
	COMPLETION_UNVERIFIED_MESSAGE,
	type ApprovalVerdict,
	type CompletionDecision,
	approvalQuestionId,
	blockedMutatingToolMessage,
	filterToolsForSurface,
	formatRetrievedChunks,
	interpretCompletion,
	isMutatingTool,
	isTerminalTool,
	type ToolSurface,
} from '../jev/agentDecisions';
import {
	beginCancellation,
	judgeCompletion,
	judgeMutatingCalls,
	rankChunksForContext,
	routeToolSurface,
	routeWriterModel,
} from '../jev/forks';
import { isAbortError } from '../jev/jevClient';

const DEFAULT_MAX_STEPS = 24;

function collectEnabledTools(
	request: vscode.ChatRequest,
	mode: AgentModeKind,
): vscode.LanguageModelChatTool[] {
	const tools: vscode.LanguageModelChatTool[] = [];
	const requestTools = (request as vscode.ChatRequest & { tools?: Map<vscode.LanguageModelToolInformation, boolean> }).tools;

	if (requestTools) {
		for (const [info, enabled] of requestTools) {
			if (!enabled) {
				continue;
			}
			if (!isToolAllowedInMode(info.name, mode)) {
				continue;
			}
			tools.push({
				name: info.name,
				description: info.description,
				inputSchema: info.inputSchema,
			});
		}
		return tools;
	}

	// Fallback: all registered tools filtered by mode.
	for (const info of vscode.lm.tools) {
		if (!isToolAllowedInMode(info.name, mode)) {
			continue;
		}
		tools.push({
			name: info.name,
			description: info.description,
			inputSchema: info.inputSchema,
		});
	}
	return tools;
}

function historyToMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
				.filter(Boolean)
				.join('\n');
			if (text) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
	}
	return messages;
}

function referencesContext(request: vscode.ChatRequest): string {
	const blocks: string[] = [];
	for (const ref of request.references) {
		if (typeof ref.value === 'string') {
			blocks.push(ref.modelDescription ? `${ref.modelDescription}\n${ref.value}` : ref.value);
		} else if (ref.value instanceof vscode.Uri) {
			blocks.push(`File: ${ref.value.fsPath}`);
		} else if (ref.value && typeof ref.value === 'object' && 'uri' in (ref.value as object)) {
			const loc = ref.value as vscode.Location;
			blocks.push(`Location: ${loc.uri.fsPath}:${loc.range.start.line + 1}`);
		}
	}
	return blocks.join('\n\n');
}

async function toolResultToText(result: vscode.LanguageModelToolResult): Promise<string> {
	const chunks: string[] = [];
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			chunks.push(part.value);
		}
	}
	return chunks.join('\n') || '(empty tool result)';
}

/**
 * Native chat participant agent loop with streaming + tool invocation.
 */
export async function runChatAgentLoop(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	index: CodebaseSearchIndex,
): Promise<vscode.ChatResult> {
	const modeName = request.modeInstructions2?.name ?? request.modeInstructions ?? 'Agent';
	const mode = inferModeKind(typeof modeName === 'string' ? modeName : 'agent');
	const agentRules = await loadAgentRules();

	const selected = request.model;
	if (!selected) {
		stream.markdown('No language model is available. Start Ollama from the Command Palette (**Integrity: Start Ollama**) or configure a BYOK provider in Integrity AI settings.');
		return {};
	}

	let model: vscode.LanguageModelChat;
	try {
		stream.progress('Consulting Jev…');
		model = await selectWriterModel(request.prompt, mode, selected, token);
	} catch (err) {
		if (isAbortError(err) || token.isCancellationRequested) {
			return {};
		}
		model = selected;
	}
	if (token.isCancellationRequested) {
		return {};
	}
	if (model.id !== selected.id) {
		stream.progress(`Using ${model.name}…`);
	}

	const parsed = parseModelId(model.id);
	if (model.family === 'ollama' || parsed.providerId === 'ollama') {
		stream.progress('Checking Ollama model…');
		const result = await ensureOllamaModelReady(parsed.model);
		if (!isOllamaModelReady(result)) {
			stream.markdown(`**${ollamaModelNotReadyMessage(parsed.model, result)}**`);
			return {};
		}
	}

	let retrieved = '';
	try {
		stream.progress('Ranking context with Jev…');
		retrieved = await rankedPrefetch(index, request.prompt, token);
	} catch (err) {
		if (isAbortError(err) || token.isCancellationRequested) {
			return {};
		}
		retrieved = '';
	}
	if (token.isCancellationRequested) {
		return {};
	}

	const extraContext = [referencesContext(request), retrieved].filter(part => part.trim()).join('\n\n');
	const system = buildSystemPrompt(mode, agentRules, extraContext);

	let tools = collectEnabledTools(request, mode);
	if (!request.toolReferences.length && tools.length) {
		try {
			stream.progress('Choosing tools with Jev…');
			const surface = await selectToolSurface(request.prompt, mode, tools, token);
			if (surface) {
				const narrowed = filterToolsForSurface(tools, surface);
				if (narrowed.length < tools.length) {
					stream.progress(toolSurfaceProgress(surface));
					tools = narrowed;
				}
			}
		} catch (err) {
			if (isAbortError(err) || token.isCancellationRequested) {
				return {};
			}
		}
		if (token.isCancellationRequested) {
			return {};
		}
	}
	const maxSteps = vscode.workspace.getConfiguration('integrity.ai').get<number>('agent.maxSteps', DEFAULT_MAX_STEPS);

	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(`[System instructions]\n${system}`),
		...historyToMessages(context),
		vscode.LanguageModelChatMessage.User(request.prompt),
	];

	let completionUnavailableStreak = 0;

	for (let step = 0; step < maxSteps; step++) {
		if (token.isCancellationRequested) {
			return {};
		}

		stream.progress(step === 0 ? 'Thinking…' : `Continuing (step ${step + 1})…`);

		let response: vscode.LanguageModelChatResponse;
		try {
			response = await model.sendRequest(messages, {
				tools: tools.length ? tools : undefined,
				toolMode: request.toolReferences.length
					? vscode.LanguageModelChatToolMode.Required
					: vscode.LanguageModelChatToolMode.Auto,
			}, token);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(`**Model error:** ${message}`);
			return {};
		}

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let textOut = '';

		try {
			for await (const part of response.stream) {
				if (token.isCancellationRequested) {
					return {};
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					assistantParts.push(part);
					textOut += part.value;
					stream.markdown(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					assistantParts.push(part);
					toolCalls.push(part);
				}
			}
		} catch (err) {
			if (token.isCancellationRequested) {
				return {};
			}
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(`\n\n**Stream error:** ${message}`);
			return {};
		}

		if (!toolCalls.length) {
			if (!textOut.trim()) {
				stream.markdown('_No response from model._');
				return {};
			}
			let decision: CompletionDecision;
			try {
				stream.progress('Checking completion with Jev…');
				decision = await completionDecision(request.prompt, textOut, completionUnavailableStreak > 0, token);
			} catch (err) {
				if (isAbortError(err) || token.isCancellationRequested) {
					return {};
				}
				decision = interpretCompletion({
					answer: undefined,
					unavailable: true,
					completionConfidence: 1,
					priorUnavailable: completionUnavailableStreak > 0,
				});
			}
			if (token.isCancellationRequested) {
				return {};
			}
			if (decision.action === 'exit') {
				return {};
			}
			if (decision.action === 'stop') {
				stream.markdown(`\n\n**${decision.message ?? COMPLETION_BLOCKED_MESSAGE}**`);
				return {};
			}
			completionUnavailableStreak = decision.unavailable ? completionUnavailableStreak + 1 : 0;
			stream.progress(decision.unavailable ? 'Completion check unavailable, continuing…' : 'Jev asked for another pass…');
			messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
			messages.push(vscode.LanguageModelChatMessage.User(decision.message ?? COMPLETION_UNVERIFIED_MESSAGE));
			continue;
		}

		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const resultParts = await settleToolCalls(toolCalls, request, stream, token);
		if (!resultParts) {
			return {};
		}
		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	stream.markdown(`\n\n_Agent reached max steps (${maxSteps})._`);
	return {};
}

/**
 * Pick a writer once per turn. A missing Jev answer keeps the model the user selected.
 */
async function selectWriterModel(
	prompt: string,
	mode: AgentModeKind,
	selected: vscode.LanguageModelChat,
	token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChat> {
	let candidates: vscode.LanguageModelChat[] = [];
	try {
		candidates = await vscode.lm.selectChatModels({ vendor: INTEGRITY_LM_VENDOR });
	} catch {
		return selected;
	}
	const linked = beginCancellation(token);
	try {
		const switchTo = await routeWriterModel(
			prompt,
			mode,
			selected.id,
			candidates.map(candidate => ({
				id: candidate.id,
				name: candidate.name,
				family: candidate.family,
				maxInputTokens: candidate.maxInputTokens,
			})),
			linked.signal,
		);
		if (!switchTo) {
			return selected;
		}
		return candidates.find(candidate => candidate.id === switchTo) ?? selected;
	} finally {
		linked.end();
	}
}

/**
 * Pick a tool ceiling once per turn. A missing Jev answer keeps every tool the mode allows.
 */
async function selectToolSurface(
	prompt: string,
	mode: AgentModeKind,
	tools: readonly vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
): Promise<ToolSurface | undefined> {
	const linked = beginCancellation(token);
	try {
		return await routeToolSurface(
			prompt,
			mode,
			tools.map(tool => ({ name: tool.name, description: tool.description })),
			linked.signal,
		);
	} finally {
		linked.end();
	}
}

function toolSurfaceProgress(surface: ToolSurface): string {
	switch (surface) {
		case 'reply':
			return 'Answering without tools…';
		case 'read':
			return 'Tools limited to read…';
		case 'edit':
			return 'Tools limited to edit…';
		case 'act':
			return 'Tools limited to act…';
	}
}

/**
 * Search the index and keep only chunks Jev marks useful. A failed rank injects nothing.
 */
async function rankedPrefetch(
	index: CodebaseSearchIndex,
	prompt: string,
	token: vscode.CancellationToken,
): Promise<string> {
	let hits: Array<{ path: string; content: string; startLine: number; endLine: number }> = [];
	try {
		hits = await index.search(prompt, 8);
	} catch {
		return '';
	}
	if (!hits.length || token.isCancellationRequested) {
		return '';
	}
	const linked = beginCancellation(token);
	try {
		const ranked = await rankChunksForContext(prompt, hits, 'drop-all', linked.signal);
		return formatRetrievedChunks(ranked);
	} finally {
		linked.end();
	}
}

async function completionDecision(
	task: string,
	assistantText: string,
	priorUnavailable: boolean,
	token: vscode.CancellationToken,
): Promise<CompletionDecision> {
	const linked = beginCancellation(token);
	try {
		return await judgeCompletion(task, assistantText, priorUnavailable, linked.signal);
	} catch (err) {
		if (isAbortError(err) || token.isCancellationRequested) {
			throw err;
		}
		return interpretCompletion({
			answer: undefined,
			unavailable: true,
			completionConfidence: 1,
			priorUnavailable,
		});
	} finally {
		linked.end();
	}
}

/**
 * Run read-only tools immediately. Mutating tools wait for one batched Jev decision.
 * @returns undefined when the turn was cancelled.
 */
async function settleToolCalls(
	toolCalls: readonly vscode.LanguageModelToolCallPart[],
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResultPart[] | undefined> {
	const slots: Array<{ call: vscode.LanguageModelToolCallPart; text: string }> = [];
	const mutating: Array<{ slot: number; call: vscode.LanguageModelToolCallPart }> = [];

	for (const call of toolCalls) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		if (!call.name?.trim()) {
			slots.push({
				call,
				text: 'Tool error: empty tool name. Call integrity_apply_patch with path and hunks/patch, or another integrity_* tool.',
			});
			continue;
		}
		const rejected = rejectionForMisroutedToolCall(call.name, call.input);
		if (rejected) {
			slots.push({ call, text: rejected });
			continue;
		}
		if (!isMutatingTool(call.name)) {
			stream.progress(`Running \`${call.name}\`…`);
			slots.push({ call, text: await invokeNamedTool(call, request, token) });
			continue;
		}
		mutating.push({ slot: slots.length, call });
		slots.push({ call, text: '' });
	}

	if (mutating.length) {
		const linked = beginCancellation(token);
		let verdicts = new Map<string, ApprovalVerdict>();
		try {
			stream.progress('Asking Jev about tool calls…');
			verdicts = await judgeMutatingCalls(mutating.map(({ call }) => ({
				id: call.callId,
				name: call.name,
				input: call.input,
			})), linked.signal);
		} catch (err) {
			if (isAbortError(err) || token.isCancellationRequested) {
				return undefined;
			}
		} finally {
			linked.end();
		}

		for (let index = 0; index < mutating.length; index++) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			const { slot, call } = mutating[index];
			const verdict = verdicts.get(approvalQuestionId(call.callId, index)) ?? {
				action: 'block' as const,
				message: blockedMutatingToolMessage(call.name),
			};
			if (verdict.action === 'block') {
				stream.progress(`Blocked \`${call.name}\` until Jev answers.`);
				slots[slot].text = verdict.message;
				continue;
			}
			if (verdict.action === 'prompt') {
				const approved = await confirmMutatingTool(approvalPrompt(call.name, call.input));
				if (token.isCancellationRequested) {
					return undefined;
				}
				if (!approved) {
					slots[slot].text = `Tool error: ${call.name} cancelled by user.`;
					continue;
				}
			}
			stream.progress(`Running \`${call.name}\`…`);
			slots[slot].text = await invokeNamedTool(call, request, token);
		}
	}

	return slots.map(slot => new vscode.LanguageModelToolResultPart(
		slot.call.callId,
		[new vscode.LanguageModelTextPart(slot.text)],
	));
}

async function invokeNamedTool(
	call: vscode.LanguageModelToolCallPart,
	request: vscode.ChatRequest,
	token: vscode.CancellationToken,
): Promise<string> {
	try {
		const result = await vscode.lm.invokeTool(call.name, {
			input: call.input,
			toolInvocationToken: request.toolInvocationToken,
		}, token);
		return toolResultToText(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `Tool error: ${message}`;
	}
}

function approvalPrompt(name: string, input: unknown): string {
	const path = extractPathFromInput(input).raw;
	switch (name) {
		case IntegrityToolName.CreateFile:
			return path ? `Create/overwrite file ${path}?` : 'Create file?';
		case IntegrityToolName.ReplaceString:
			return path ? `Apply unique replace in ${path}?` : 'Apply unique replace?';
		case IntegrityToolName.ApplyPatch:
			return path ? `Apply patch to ${path}?` : 'Apply patch?';
		default: {
			if (isTerminalTool(name)) {
				const command = commandFromInput(input);
				return command ? `Run terminal command: ${command}?` : 'Run this terminal command?';
			}
			return `Run ${name}?`;
		}
	}
}

function commandFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const command = (input as Record<string, unknown>).command;
	if (typeof command !== 'string' || !command.trim()) {
		return undefined;
	}
	const trimmed = command.trim();
	return trimmed.length > 180 ? trimmed.slice(0, 180) + '…' : trimmed;
}

async function confirmMutatingTool(message: string): Promise<boolean> {
	const approved = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		'Apply',
		'Cancel',
	);
	return approved === 'Apply';
}

/**
 * Register the default Integrity chat participant.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, index: CodebaseSearchIndex): void {
	const participant = vscode.chat.createChatParticipant(
		'integrity.integrity-ai',
		async (request, context, stream, token) => {
			return runChatAgentLoop(request, context, stream, token, index);
		},
	);
	participant.iconPath = new vscode.ThemeIcon('shield');

	context.subscriptions.push(participant);
}
