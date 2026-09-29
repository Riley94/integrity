/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildSystemPrompt } from './agentPrompt';
import { rejectionForMisroutedToolCall } from './browserToolGuard';
import { loadAgentRules } from './lmTools';
import { inferModeKind, isToolAllowedInMode, type AgentModeKind } from './toolNames';
import { parseModelId } from '../providers/modelId';
import { ensureOllamaModelReady, isOllamaModelReady, ollamaModelNotReadyMessage } from '../ollama/ensureOllamaModel';

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
): Promise<vscode.ChatResult> {
	const modeName = request.modeInstructions2?.name ?? request.modeInstructions ?? 'Agent';
	const mode = inferModeKind(typeof modeName === 'string' ? modeName : 'agent');
	const agentRules = await loadAgentRules();
	const extraContext = referencesContext(request);
	const system = buildSystemPrompt(mode, agentRules, extraContext);

	const model = request.model;
	if (!model) {
		stream.markdown('No language model is available. Start Ollama from the Command Palette (**Integrity: Start Ollama**) or configure a BYOK provider in Integrity AI settings.');
		return {};
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

	const tools = collectEnabledTools(request, mode);
	const maxSteps = vscode.workspace.getConfiguration('integrity.ai').get<number>('agent.maxSteps', DEFAULT_MAX_STEPS);

	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(`[System instructions]\n${system}`),
		...historyToMessages(context),
		vscode.LanguageModelChatMessage.User(request.prompt),
	];

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
			}
			return {};
		}

		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const resultParts: vscode.LanguageModelToolResultPart[] = [];
		for (const call of toolCalls) {
			if (token.isCancellationRequested) {
				return {};
			}
			if (!call.name?.trim()) {
				resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [
					new vscode.LanguageModelTextPart(
						'Tool error: empty tool name. Call integrity_apply_patch with path and hunks/patch, or another integrity_* tool.',
					),
				]));
				continue;
			}
			stream.progress(`Running \`${call.name}\`…`);
			const rejected = rejectionForMisroutedToolCall(call.name, call.input);
			if (rejected) {
				resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [
					new vscode.LanguageModelTextPart(rejected),
				]));
				continue;
			}
			try {
				const result = await vscode.lm.invokeTool(call.name, {
					input: call.input,
					toolInvocationToken: request.toolInvocationToken,
				}, token);
				const text = await toolResultToText(result);
				resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(text)]));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [
					new vscode.LanguageModelTextPart(`Tool error: ${message}`),
				]));
			}
		}

		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	stream.markdown(`\n\n_Agent reached max steps (${maxSteps})._`);
	return {};
}

/**
 * Register the default Integrity chat participant.
 */
export function registerChatParticipant(context: vscode.ExtensionContext): void {
	const participant = vscode.chat.createChatParticipant(
		'integrity.integrity-ai',
		async (request, context, stream, token) => {
			return runChatAgentLoop(request, context, stream, token);
		},
	);
	participant.iconPath = new vscode.ThemeIcon('shield');

	context.subscriptions.push(participant);
}
