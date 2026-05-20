import type { Tool } from './tools.js';

export function toMcpTools(tools: Tool[]): Array<{
	name: string;
	description: string;
	inputSchema: object;
}> {
	return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function handleMcpCall(
	tools: Tool[],
	name: string,
	input: Record<string, unknown>,
): {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
} {
	const tool = tools.find(t => t.name === name);
	if (!tool) throw new Error(`Unknown tool: ${name}`);
	try {
		const result = tool.execute(input);
		return { content: [{ type: 'text', text: JSON.stringify(result) }] };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { content: [{ type: 'text', text: msg }], isError: true };
	}
}
