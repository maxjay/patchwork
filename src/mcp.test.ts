import { describe, it, expect } from 'vitest';
import { toMcpTools, handleMcpCall } from './mcp.js';
import type { Tool } from './tools.js';

function makeTool(name: string, result: unknown = { ok: true }, fail = false): Tool {
	return {
		name,
		description: `${name} desc`,
		inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
		execute: (_input: unknown) => {
			if (fail) throw new Error(`${name} failed`);
			return result;
		},
	};
}

describe('toMcpTools', () => {
	it('preserves name, description, inputSchema', () => {
		const tools = [makeTool('add'), makeTool('replace')];
		const result = toMcpTools(tools);
		expect(result).toEqual([
			{ name: 'add', description: 'add desc', inputSchema: tools[0].inputSchema },
			{ name: 'replace', description: 'replace desc', inputSchema: tools[1].inputSchema },
		]);
	});
});

describe('handleMcpCall', () => {
	it('returns content with serialized result on success', () => {
		const tools = [makeTool('add', { ok: true })];
		const result = handleMcpCall(tools, 'add', { x: 'hello' });
		expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
		expect(result.isError).toBeUndefined();
	});

	it('sets isError true and puts error text in content on execution failure', () => {
		const tools = [makeTool('boom', undefined, true)];
		const result = handleMcpCall(tools, 'boom', {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('boom failed');
	});

	it('throws on unknown tool name', () => {
		expect(() => handleMcpCall([], 'ghost', {})).toThrow('Unknown tool: ghost');
	});
});
