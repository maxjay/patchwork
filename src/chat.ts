import type { Tool } from './tools.js';

export interface AgentMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	toolCalls?: Array<{ id: string; name: string; input: unknown }>;
	toolCallId?: string;
	toolResult?: unknown;
}

export interface AgentTool {
	name: string;
	description: string;
	inputSchema: object;
}

export interface NativeAdapter {
	mode: 'native';
	call: (
		messages: AgentMessage[],
		tools: AgentTool[],
	) => Promise<{
		text?: string;
		toolCalls?: Array<{ id: string; name: string; input: unknown }>;
	}>;
}

export interface PromptAdapter {
	mode: 'prompt';
	call: (messages: AgentMessage[]) => Promise<{ text: string }>;
}

export type ModelAdapter = NativeAdapter | PromptAdapter;

export function toAgentTools(tools: Tool[]): AgentTool[] {
	return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function runOne(tools: Tool[], name: string, input: unknown): unknown {
	const tool = tools.find(t => t.name === name);
	if (!tool) return { error: `Unknown tool: ${name}` };
	try {
		return tool.execute(input as Record<string, unknown>);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

function parseToolCalls(text: string): Array<{ name: string; input: unknown }> {
	const out: Array<{ name: string; input: unknown }> = [];
	const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		try {
			const parsed = JSON.parse(m[1].trim());
			if (parsed && typeof parsed.name === 'string') {
				out.push({ name: parsed.name, input: parsed.input });
			}
		} catch {
			// ignore malformed block
		}
	}
	return out;
}

function buildToolSystemFragment(tools: Tool[]): string {
	const toolList = tools
		.map(t => `- ${t.name}: ${t.description}\n  Input schema: ${JSON.stringify(t.inputSchema)}`)
		.join('\n');
	return (
		'You have access to tools. To call a tool, output a block in this exact format:\n\n' +
		'<tool_call>{"name":"<tool>","input":<json>}</tool_call>\n\n' +
		'You may include multiple <tool_call> blocks in one response; they will be executed in order. ' +
		'After tool execution you will see lines starting with "Tool result (<name>):" with the result JSON. ' +
		'When you are done, reply normally without a <tool_call> block.\n\n' +
		'Available tools:\n' +
		toolList
	);
}

function flattenForPromptMode(messages: AgentMessage[]): AgentMessage[] {
	return messages.map(m => {
		if (m.role === 'tool') {
			return {
				role: 'user' as const,
				content: `Tool result (${m.toolCallId ?? 'unknown'}): ${JSON.stringify(m.toolResult)}`,
			};
		}
		if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
			const callText = m.toolCalls
				.map(tc => `<tool_call>${JSON.stringify({ name: tc.name, input: tc.input })}</tool_call>`)
				.join('\n');
			return {
				role: 'assistant' as const,
				content: m.content ? `${m.content}\n${callText}` : callText,
			};
		}
		return { role: m.role, content: m.content };
	});
}

let _idCounter = 0;
function nextId(): string {
	return `tc_${(_idCounter++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function runAgentLoop(
	tools: Tool[],
	messages: AgentMessage[],
	adapter: ModelAdapter,
	options?: { maxIterations?: number },
): Promise<{ reply: string; newMessages: AgentMessage[] }> {
	const maxIterations = options?.maxIterations ?? 10;
	const agentTools = toAgentTools(tools);
	const newMessages: AgentMessage[] = [];

	if (adapter.mode === 'native') {
		const working = [...messages];

		for (let i = 0; i < maxIterations; i++) {
			const r = await adapter.call(working, agentTools);
			const assistantMsg: AgentMessage = {
				role: 'assistant',
				content: r.text,
				toolCalls: r.toolCalls,
			};
			working.push(assistantMsg);
			newMessages.push(assistantMsg);

			if (!r.toolCalls || r.toolCalls.length === 0) {
				return { reply: r.text ?? '', newMessages };
			}

			for (const tc of r.toolCalls) {
				const result = runOne(tools, tc.name, tc.input);
				const toolMsg: AgentMessage = {
					role: 'tool',
					toolCallId: tc.id,
					toolResult: result,
				};
				working.push(toolMsg);
				newMessages.push(toolMsg);
			}
		}
	} else {
		const fragment = buildToolSystemFragment(tools);
		const base = [...messages];
		if (base.length > 0 && base[0].role === 'system') {
			base[0] = { ...base[0], content: (base[0].content ?? '') + '\n\n' + fragment };
		} else {
			base.unshift({ role: 'system', content: fragment });
		}
		const working = base;

		for (let i = 0; i < maxIterations; i++) {
			const flattened = flattenForPromptMode(working);
			const r = await adapter.call(flattened);

			const calls = parseToolCalls(r.text);
			const assistantMsg: AgentMessage = { role: 'assistant', content: r.text };
			working.push(assistantMsg);
			newMessages.push(assistantMsg);

			if (calls.length === 0) {
				return { reply: r.text, newMessages };
			}

			for (const call of calls) {
				const id = nextId();
				const result = runOne(tools, call.name, call.input);
				const toolMsg: AgentMessage = {
					role: 'tool',
					toolCallId: id,
					toolResult: result,
					content: `Tool result (${call.name}): ${JSON.stringify(result)}`,
				};
				working.push(toolMsg);
				newMessages.push(toolMsg);
			}
		}
	}

	throw new Error(`runAgentLoop exceeded maxIterations (${maxIterations}) without a final reply`);
}
