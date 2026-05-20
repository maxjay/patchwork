import { describe, it, expect, vi } from 'vitest';
import { toAgentTools, runAgentLoop } from './chat.js';
import type { Tool } from './tools.js';
import type { AgentMessage, NativeAdapter, PromptAdapter } from './chat.js';

function makeTool(name: string, result: unknown = { ok: true }, fail = false): Tool {
	return {
		name,
		description: `${name} tool`,
		inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
		execute: (_input: unknown) => {
			if (fail) throw new Error(`${name} failed`);
			return result;
		},
	};
}

describe('toAgentTools', () => {
	it('maps name, description, inputSchema', () => {
		const tools = [makeTool('add'), makeTool('replace')];
		const result = toAgentTools(tools);
		expect(result).toEqual([
			{ name: 'add', description: 'add tool', inputSchema: tools[0].inputSchema },
			{ name: 'replace', description: 'replace tool', inputSchema: tools[1].inputSchema },
		]);
	});
});

describe('runAgentLoop — native', () => {
	it('returns reply when model gives no tool calls', async () => {
		const adapter: NativeAdapter = {
			mode: 'native',
			call: vi.fn().mockResolvedValue({ text: 'Done.' }),
		};
		const tools = [makeTool('add')];
		const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }];
		const { reply, newMessages } = await runAgentLoop(tools, messages, adapter);
		expect(reply).toBe('Done.');
		expect(newMessages).toHaveLength(1);
		expect(newMessages[0]).toMatchObject({ role: 'assistant', content: 'Done.' });
	});

	it('executes tool calls then returns final reply', async () => {
		const callFn = vi.fn()
			.mockResolvedValueOnce({ text: undefined, toolCalls: [{ id: 'tc1', name: 'add', input: { x: '1' } }] })
			.mockResolvedValueOnce({ text: 'All done.' });
		const adapter: NativeAdapter = { mode: 'native', call: callFn };
		const tool = makeTool('add', { ok: true });
		const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];

		const { reply, newMessages } = await runAgentLoop([tool], messages, adapter);

		expect(reply).toBe('All done.');
		expect(newMessages).toHaveLength(3);
		expect(newMessages[0]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'tc1', name: 'add' }] });
		expect(newMessages[1]).toMatchObject({ role: 'tool', toolCallId: 'tc1', toolResult: { ok: true } });
		expect(newMessages[2]).toMatchObject({ role: 'assistant', content: 'All done.' });
	});

	it('throws when maxIterations exhausted', async () => {
		const adapter: NativeAdapter = {
			mode: 'native',
			call: vi.fn().mockResolvedValue({ toolCalls: [{ id: 'tc1', name: 'add', input: {} }] }),
		};
		await expect(
			runAgentLoop([makeTool('add')], [], adapter, { maxIterations: 2 }),
		).rejects.toThrow('maxIterations');
	});

	it('does not mutate the caller messages array', async () => {
		const adapter: NativeAdapter = {
			mode: 'native',
			call: vi.fn().mockResolvedValue({ text: 'ok' }),
		};
		const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }];
		const before = messages.length;
		await runAgentLoop([], messages, adapter);
		expect(messages.length).toBe(before);
	});

	it('wraps tool execution errors as { error } without throwing', async () => {
		const callFn = vi.fn()
			.mockResolvedValueOnce({ toolCalls: [{ id: 'tc1', name: 'boom', input: {} }] })
			.mockResolvedValueOnce({ text: 'recovered' });
		const adapter: NativeAdapter = { mode: 'native', call: callFn };

		const { newMessages } = await runAgentLoop([makeTool('boom', undefined, true)], [], adapter);
		const toolMsg = newMessages.find(m => m.role === 'tool');
		expect((toolMsg?.toolResult as any).error).toMatch('boom failed');
	});
});

describe('runAgentLoop — prompt', () => {
	it('returns reply when no tool_call tag in response', async () => {
		const adapter: PromptAdapter = {
			mode: 'prompt',
			call: vi.fn().mockResolvedValue({ text: 'Plain answer.' }),
		};
		const { reply, newMessages } = await runAgentLoop([makeTool('add')], [], adapter);
		expect(reply).toBe('Plain answer.');
		expect(newMessages).toHaveLength(1);
		expect(newMessages[0]).toMatchObject({ role: 'assistant', content: 'Plain answer.' });
	});

	it('parses a single tool_call, executes it, loops, returns final reply', async () => {
		const callFn = vi.fn()
			.mockResolvedValueOnce({ text: '<tool_call>{"name":"add","input":{"x":"1"}}</tool_call>' })
			.mockResolvedValueOnce({ text: 'Done with tool.' });
		const adapter: PromptAdapter = { mode: 'prompt', call: callFn };

		const { reply, newMessages } = await runAgentLoop([makeTool('add', { ok: true })], [], adapter);
		expect(reply).toBe('Done with tool.');
		// assistant (with tool call text) + tool result + final assistant
		expect(newMessages).toHaveLength(3);
		expect(newMessages[1]).toMatchObject({ role: 'tool', toolResult: { ok: true } });
	});

	it('parses multiple tool_call blocks in source order, executes sequentially', async () => {
		const executeSpy = vi.fn().mockReturnValue({ ok: true });
		const tool: Tool = { name: 'add', description: 'd', inputSchema: {}, execute: executeSpy };

		const callFn = vi.fn()
			.mockResolvedValueOnce({
				text: '<tool_call>{"name":"add","input":{"x":"first"}}</tool_call>\n<tool_call>{"name":"add","input":{"x":"second"}}</tool_call>',
			})
			.mockResolvedValueOnce({ text: 'done' });
		const adapter: PromptAdapter = { mode: 'prompt', call: callFn };

		const { newMessages } = await runAgentLoop([tool], [], adapter);
		// assistant + two tool results + final assistant
		expect(newMessages).toHaveLength(4);
		expect(executeSpy).toHaveBeenCalledTimes(2);
		expect(executeSpy.mock.calls[0][0]).toEqual({ x: 'first' });
		expect(executeSpy.mock.calls[1][0]).toEqual({ x: 'second' });
	});

	it('silently ignores malformed JSON in tool_call and treats response as final', async () => {
		const adapter: PromptAdapter = {
			mode: 'prompt',
			call: vi.fn().mockResolvedValue({ text: '<tool_call>NOT_JSON</tool_call>' }),
		};
		const { reply } = await runAgentLoop([makeTool('add')], [], adapter);
		expect(reply).toContain('NOT_JSON');
	});

	it('does not mutate the caller messages array', async () => {
		const adapter: PromptAdapter = {
			mode: 'prompt',
			call: vi.fn().mockResolvedValue({ text: 'hi' }),
		};
		const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }];
		const before = messages.length;
		await runAgentLoop([], messages, adapter);
		expect(messages.length).toBe(before);
	});

	it('injects system prompt fragment with tool names and input schemas', async () => {
		const callFn = vi.fn().mockResolvedValue({ text: 'ok' });
		const adapter: PromptAdapter = { mode: 'prompt', call: callFn };
		const tools = [makeTool('myTool')];

		await runAgentLoop(tools, [], adapter);

		const firstCallMessages: AgentMessage[] = callFn.mock.calls[0][0];
		const sys = firstCallMessages.find(m => m.role === 'system');
		expect(sys?.content).toContain('myTool');
		expect(sys?.content).toContain('<tool_call>');
		expect(sys?.content).toContain('Input schema:');
	});

	it('appends tool fragment to existing system message rather than prepending a new one', async () => {
		const callFn = vi.fn().mockResolvedValue({ text: 'ok' });
		const adapter: PromptAdapter = { mode: 'prompt', call: callFn };
		const messages: AgentMessage[] = [{ role: 'system', content: 'You are helpful.' }];

		await runAgentLoop([], messages, adapter);

		const firstCallMessages: AgentMessage[] = callFn.mock.calls[0][0];
		const sysMsgs = firstCallMessages.filter(m => m.role === 'system');
		expect(sysMsgs).toHaveLength(1);
		expect(sysMsgs[0].content).toContain('You are helpful.');
	});

	it('throws when maxIterations exhausted', async () => {
		const adapter: PromptAdapter = {
			mode: 'prompt',
			call: vi.fn().mockResolvedValue({ text: '<tool_call>{"name":"add","input":{}}</tool_call>' }),
		};
		await expect(
			runAgentLoop([makeTool('add')], [], adapter, { maxIterations: 2 }),
		).rejects.toThrow('maxIterations');
	});
});
