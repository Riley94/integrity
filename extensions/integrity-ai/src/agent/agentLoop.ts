/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderRouter } from '../providers/router';
import type { Message } from '../providers/types';
import { AgentTools, loadAgentRules } from './tools';

/**
 * Legacy webview agent loop (JSON tool-calling).
 * Native Chat uses {@link runChatAgentLoop} in chatParticipant.ts instead.
 * Kept so the Integrity Status webview Agent checkbox still works.
 */
const TOOL_SCHEMA = `You are an agent in Integrity IDE. Respond with JSON tool calls when you need to act.

Available tools:
- read_file(path): Read a workspace file
- edit_file(path, oldText, newText): Replace text in a file (show diff before apply)
- list_dir(path): List directory contents
- search(pattern): Search workspace with ripgrep-like pattern
- codebase_search(query): Semantic search over indexed codebase
- run_terminal(command): Run a shell command (requires user approval)

When you need a tool, respond ONLY with JSON:
{"tool":"<name>","args":{...}}

When done, respond with plain text summary (no JSON).`;

export class AgentLoop {
	private tools: AgentTools;
	private readonly maxSteps = 12;

	constructor(
		private readonly router: ProviderRouter,
		index: { search(query: string, topK?: number): Promise<Array<{ path: string; content: string; startLine: number; endLine: number }>> },
	) {
		this.tools = new AgentTools(index);
	}

	async run(userTask: string, systemContext: string): Promise<string> {
		const config = vscode.workspace.getConfiguration('integrity.ai');
		const requireTerminalApproval = config.get<boolean>('agent.requireTerminalApproval', true);
		const requireEditApproval = config.get<boolean>('agent.requireEditApproval', true);

		const agentRules = await loadAgentRules();
		const messages: Message[] = [
			{ role: 'system', content: `${TOOL_SCHEMA}\n\n${systemContext}\n\n${agentRules}` },
			{ role: 'user', content: userTask },
		];

		const model = await this.router.getAvailableProvider();
		const transcript: string[] = [];

		for (let step = 0; step < this.maxSteps; step++) {
			let response = '';
			for await (const chunk of model.chat(messages)) {
				response += chunk;
			}

			const toolCall = this.parseToolCall(response);
			if (!toolCall) {
				return response;
			}

			transcript.push(`Tool: ${toolCall.tool}(${JSON.stringify(toolCall.args)})`);

			const result = await this.tools.execute(toolCall.tool, toolCall.args, {
				requireTerminalApproval,
				requireEditApproval,
			});

			transcript.push(`Result: ${result}`);
			messages.push({ role: 'assistant', content: response });
			messages.push({ role: 'user', content: `Tool result:\n${result}` });
		}

		return `Agent reached max steps.\n\n${transcript.join('\n\n')}`;
	}

	private parseToolCall(response: string): { tool: string; args: Record<string, string> } | null {
		const trimmed = response.trim();
		try {
			const parsed = JSON.parse(trimmed) as { tool?: string; args?: Record<string, string> };
			if (parsed.tool && parsed.args) {
				return { tool: parsed.tool, args: parsed.args };
			}
		} catch {
			const match = trimmed.match(/\{[\s\S]*"tool"[\s\S]*\}/);
			if (match) {
				try {
					const parsed = JSON.parse(match[0]) as { tool?: string; args?: Record<string, string> };
					if (parsed.tool && parsed.args) {
						return { tool: parsed.tool, args: parsed.args };
					}
				} catch {
					// not a tool call
				}
			}
		}
		return null;
	}
}
