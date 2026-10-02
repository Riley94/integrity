/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildSystemPrompt, type SelectedToolPrompt } from './agentPrompt';
import { rejectionForMisroutedToolCall } from './browserToolGuard';
import {
	editReviewPending,
	emptyEditReviewState,
	holdReplyForEditReview,
	MAX_EDIT_REVIEWS,
	noteToolResult,
	withReviewReadTool,
	type EditReviewState,
} from './editReview';
import { loadAgentRules, type CodebaseSearchIndex } from './lmTools';
import { extractPathFromInput } from './pathPolicy';
import { scratchpadApprovalPreview } from './scratchpad';
import { applyScratchpadHostRule, holdReplyForScratchpad } from './scratchpadHostRule';
import {
	continuationTask,
	noteSessionWrite,
	previousUserPrompt,
	sessionFilesResult,
	unionSessionFiles,
	type SessionFileRecord,
	type SessionHistoryTurn,
} from './sessionFiles';
import { buildThinkingRequest, THINKING_PART_ID, THINKING_SYSTEM_PROMPT, thinkingContextMessage } from './thinkingPass';
import { EDIT_TOOLS, inferModeKind, IntegrityToolName, selectToolsForJev, type AgentModeKind } from './toolNames';
import { parseModelId } from '../providers/modelId';
import { ensureOllamaModelReady, isOllamaModelReady, ollamaModelNotReadyMessage } from '../ollama/ensureOllamaModel';
import {
	describeSkippedToolSurface,
	formatRetrievedChunks,
	formatJevDebug,
	isMutatingTool,
	isTerminalTool,
	mutatingToolNeedsConfirmation,
	rejectionForUnselectedTool,
} from '../jev/agentDecisions';
import {
	beginCancellation,
	rankChunksForContext,
	readJevRuntime,
	routeToolSurface,
} from '../jev/forks';
import { isAbortError } from '../jev/jevClient';

const DEFAULT_MAX_STEPS = 24;

function collectEnabledTools(
	request: vscode.ChatRequest,
	mode: AgentModeKind,
): vscode.LanguageModelChatTool[] {
	const requestTools = (request as vscode.ChatRequest & { tools?: Map<vscode.LanguageModelToolInformation, boolean> }).tools;
	return selectToolsForJev(mode, requestTools, [...vscode.lm.tools]).map(info => ({
		name: info.name,
		description: info.description,
		inputSchema: info.inputSchema,
	}));
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

/**
 * Prior turns as plain data. The current request is not in `context.history`.
 */
function historyForSession(context: vscode.ChatContext): SessionHistoryTurn[] {
	const turns: SessionHistoryTurn[] = [];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			turns.push({ kind: 'user', prompt: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			turns.push({ kind: 'assistant', metadata: turn.result?.metadata });
		}
	}
	return turns;
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

	// The writer is the model the user selected.
	const model = request.model;
	if (!model) {
		stream.markdown('No language model is available. Start Ollama from the Command Palette (**Integrity: Start Ollama**) or configure a BYOK provider in Integrity AI settings.');
		return {};
	}
	if (token.isCancellationRequested) {
		return {};
	}

	const historyTurns = historyForSession(context);
	const priorFiles = unionSessionFiles(historyTurns);
	const task = continuationTask(request.prompt, previousUserPrompt(historyTurns), priorFiles);

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
		retrieved = await rankedPrefetch(index, task, token);
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

	let tools = collectEnabledTools(request, mode);
	// Full set this mode offered, before Jev narrows it. A review can add the read tool back from here.
	const toolCatalog = tools;
	let selectedTools: SelectedToolPrompt[] = [];
	let scratchpadRequired = false;
	let readBeforeEdit = false;
	if (!tools.length) {
		printJevDebug(stream, describeSkippedToolSurface('no tools were enabled'));
	} else {
		const catalog = tools;
		let jevSelected: vscode.LanguageModelChatTool[] = [];
		try {
			stream.progress('Choosing tools with Jev…');
			const trace = await selectToolSurface(task, mode, catalog, token);
			printJevDebug(stream, formatJevDebug(trace.request, trace.text));
			const selectedNames = new Set(trace.toolNames);
			jevSelected = catalog.filter(tool => selectedNames.has(tool.name));
		} catch (err) {
			if (isAbortError(err) || token.isCancellationRequested) {
				return {};
			}
			const message = err instanceof Error ? err.message : String(err);
			printJevDebug(stream, describeSkippedToolSurface(message));
			jevSelected = [];
		}
		if (token.isCancellationRequested) {
			return {};
		}
		const ruled = applyScratchpadHostRule(jevSelected, catalog, request.prompt);
		scratchpadRequired = ruled.forced;
		if (ruled.tools.length) {
			let ruledTools = ruled.tools;
			const keepRead = priorFiles.length > 0 && ruledTools.some(tool => EDIT_TOOLS.has(tool.name));
			if (keepRead) {
				ruledTools = [...withReviewReadTool(ruledTools, catalog)];
			}
			readBeforeEdit = keepRead && ruledTools.some(tool => tool.name === IntegrityToolName.ReadFile);
			selectedTools = ruledTools.map(tool => ({ name: tool.name, description: tool.description }));
			tools = ruledTools;
			const keptByHost = scratchpadRequired
				&& !jevSelected.some(tool => tool.name === IntegrityToolName.Scratchpad);
			if (keptByHost) {
				printJevDebug(stream, 'Jev tools\ndecision: host rule kept integrity_scratchpad');
			}
			stream.progress(`Using ${tools.map(tool => tool.name).join(', ')}…`);
		} else {
			tools = [];
			stream.progress('Answering without tools…');
		}
	}
	const system = buildSystemPrompt(mode, agentRules, extraContext, selectedTools, scratchpadRequired, priorFiles, readBeforeEdit);
	const maxSteps = vscode.workspace.getConfiguration('integrity.ai').get<number>('agent.maxSteps', DEFAULT_MAX_STEPS);

	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(`[System instructions]\n${system}`),
		...historyToMessages(context),
		vscode.LanguageModelChatMessage.User(request.prompt),
	];

	let scratchpadRan = false;
	let reviewState: EditReviewState = emptyEditReviewState();
	let writtenFiles: readonly SessionFileRecord[] = [];
	const canReviewEdits = toolCatalog.some(tool => tool.name === IntegrityToolName.ReadFile);

	/**
	 * Persist this turn's writes. A cancellation leaves metadata empty so a stopped turn
	 * does not claim files the user may have rejected mid-flight.
	 */
	function finishTurn(): vscode.ChatResult {
		return sessionFilesResult(writtenFiles);
	}

	// The system prompt names only the tools Jev kept. A review has to be allowed to call the read tool.
	function grantReadFileForReview(): void {
		const next = withReviewReadTool(tools, toolCatalog);
		if (next === tools) {
			return;
		}
		tools = [...next];
		selectedTools = tools.map(tool => ({ name: tool.name, description: tool.description }));
		messages[0] = vscode.LanguageModelChatMessage.User(
			`[System instructions]\n${buildSystemPrompt(mode, agentRules, extraContext, selectedTools, scratchpadRequired, priorFiles, readBeforeEdit)}`,
		);
	}

	const thinking = await collectThinkingTrace(model, request.prompt, stream, token);
	if (thinking.cancelled) {
		return {};
	}
	const thinkingNote = thinkingContextMessage(thinking.trace);
	if (thinkingNote) {
		messages.push(vscode.LanguageModelChatMessage.User(thinkingNote));
	}

	for (let step = 0; step < maxSteps; step++) {
		if (token.isCancellationRequested) {
			return {};
		}

		if (step > 0) {
			stream.progress(`Continuing (step ${step + 1})…`);
		}
		// Prose written before the scratchpad runs, or before changed files are reviewed, is not the answer.
		const scratchpadPending = scratchpadRequired && !scratchpadRan;
		const reviewPending = canReviewEdits && editReviewPending(reviewState);

		let response: vscode.LanguageModelChatResponse;
		try {
			response = await model.sendRequest(messages, {
				tools: tools.length ? tools : undefined,
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			}, token);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(`**Model error:** ${message}`);
			return finishTurn();
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
					if (!scratchpadPending && !reviewPending) {
						stream.markdown(part.value);
					}
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
			return finishTurn();
		}

		if (!toolCalls.length) {
			if (!textOut.trim()) {
				stream.markdown('_No response from model._');
				return finishTurn();
			}
			const decision = holdReplyForScratchpad(scratchpadPending);
			if (decision.action === 'continue') {
				stream.progress('Waiting for the scratchpad before answering…');
				messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
				messages.push(vscode.LanguageModelChatMessage.User(decision.message));
				continue;
			}
			const review = holdReplyForEditReview(reviewState, canReviewEdits);
			if (review.action === 'exit') {
				return finishTurn();
			}
			reviewState = review.state;
			grantReadFileForReview();
			stream.progress(`Reviewing changed files (${reviewState.reviews} of ${MAX_EDIT_REVIEWS})…`);
			messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
			messages.push(vscode.LanguageModelChatMessage.User(review.message));
			continue;
		}

		if (toolCalls.some(call => call.name === IntegrityToolName.Scratchpad)) {
			scratchpadRan = true;
		}
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const resultParts = await settleToolCalls(
			toolCalls,
			selectedTools.map(tool => tool.name),
			request,
			stream,
			token,
			(name, input, text) => {
				reviewState = noteToolResult(reviewState, name, input, text);
				writtenFiles = noteSessionWrite(writtenFiles, name, text);
			},
		);
		if (!resultParts) {
			return {};
		}
		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	stream.markdown(`\n\n_Agent reached max steps (${maxSteps})._`);
	return finishTurn();
}

interface ThinkingTrace {
	/** True when the user cancelled during the thinking call. The turn should stop. */
	cancelled: boolean;
	/** Model text. Empty when thinking failed or produced nothing, so the task still runs. */
	trace: string;
}

/**
 * Ask the model four questions about the request before tools are available.
 * Deltas go to the Thinking box and are not the visible reply.
 * A model or stream error returns an empty trace so the task still runs.
 */
async function collectThinkingTrace(
	model: vscode.LanguageModelChat,
	prompt: string,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<ThinkingTrace> {
	if (token.isCancellationRequested) {
		return { cancelled: true, trace: '' };
	}

	let response: vscode.LanguageModelChatResponse;
	try {
		response = await model.sendRequest([
			vscode.LanguageModelChatMessage.User(`[System instructions]\n${THINKING_SYSTEM_PROMPT}`),
			vscode.LanguageModelChatMessage.User(buildThinkingRequest(prompt)),
		], {}, token);
	} catch (err) {
		if (isAbortError(err) || token.isCancellationRequested) {
			return { cancelled: true, trace: '' };
		}
		return { cancelled: false, trace: '' };
	}

	let trace = '';
	try {
		for await (const part of response.stream) {
			if (token.isCancellationRequested) {
				return { cancelled: true, trace: '' };
			}
			if (part instanceof vscode.LanguageModelTextPart) {
				trace += part.value;
				stream.thinkingProgress({ id: THINKING_PART_ID, text: part.value });
			}
		}
	} catch (err) {
		if (isAbortError(err) || token.isCancellationRequested) {
			return { cancelled: true, trace: '' };
		}
		return { cancelled: false, trace: '' };
	}
	return { cancelled: false, trace };
}

/**
 * Ask Jev which tools this turn needs. A missing answer leaves the writer with no tool.
 * The returned text is the raw answer and that decision.
 */
async function selectToolSurface(
	prompt: string,
	mode: AgentModeKind,
	tools: readonly vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
) {
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

/** True when `integrity.ai.jev.debug` should print Jev requests and replies in chat. */
function jevDebugEnabled(): boolean {
	return vscode.workspace.getConfiguration('integrity.ai').get<boolean>('jev.debug', false);
}

function printJevDebug(stream: vscode.ChatResponseStream, text: string): void {
	if (!jevDebugEnabled()) {
		return;
	}
	stream.markdown('```\n' + text + '\n```\n\n');
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

/**
 * Run read-only tools immediately. Mutating tools wait for the user when that
 * tool kind's approval setting is on. Jev does not take part in this decision.
 * @param onResult Called for each settled call, including rejections, so the turn can track writes.
 * @returns undefined when the turn was cancelled.
 */
async function settleToolCalls(
	toolCalls: readonly vscode.LanguageModelToolCallPart[],
	selectedTools: readonly string[],
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	onResult?: (name: string, input: unknown, text: string) => void,
): Promise<vscode.LanguageModelToolResultPart[] | undefined> {
	const slots: Array<{ call: vscode.LanguageModelToolCallPart; text: string }> = [];
	const { requireEditApproval, requireTerminalApproval } = readJevRuntime();

	for (const call of toolCalls) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		if (!call.name?.trim()) {
			slots.push({
				call,
				text: 'Tool error: empty tool name.',
			});
			continue;
		}
		const unselected = rejectionForUnselectedTool(call.name, selectedTools);
		if (unselected) {
			slots.push({ call, text: unselected });
			continue;
		}
		const rejected = rejectionForMisroutedToolCall(call.name, call.input);
		if (rejected) {
			slots.push({ call, text: rejected });
			continue;
		}
		if (isMutatingTool(call.name) && mutatingToolNeedsConfirmation(call.name, requireEditApproval, requireTerminalApproval)) {
			const approved = await confirmMutatingTool(approvalPrompt(call.name, call.input));
			if (token.isCancellationRequested) {
				return undefined;
			}
			if (!approved) {
				slots.push({ call, text: `Tool error: ${call.name} cancelled by user.` });
				continue;
			}
		}
		stream.progress(`Running \`${call.name}\`…`);
		slots.push({ call, text: await invokeNamedTool(call, request, token) });
	}

	for (const slot of slots) {
		onResult?.(slot.call.name, slot.call.input, slot.text);
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
		case IntegrityToolName.Scratchpad:
			return scratchpadApprovalPreview(codeFromInput(input) ?? '');
		default: {
			if (isTerminalTool(name)) {
				const command = commandFromInput(input);
				return command ? `Run terminal command: ${command}?` : 'Run this terminal command?';
			}
			return `Run ${name}?`;
		}
	}
}

function codeFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const code = (input as Record<string, unknown>).code;
	return typeof code === 'string' ? code : undefined;
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
