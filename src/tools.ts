import type { JsonValue } from 'jsonpath-rfc9535';
import type { DiffOp } from './engine.js';

// Framework-neutral tool definition. Anthropic / OpenAI / MCP adapters
// wrap this shape into their respective formats.
export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema: object;
	execute(input: TInput): TOutput;
}

// The slice of Engine / NodeEngine that the tools call into. Defined
// structurally so both classes satisfy it without changes — and so the
// caller can pass a NodeEngine to scope the LLM to a subtree.
export type EngineLike = {
	add(path: string, value: any): void;
	replace(path: string, value: any): void;
	delete(path: string): void;
	move(from: string, to: string): void;
	copy(from: string, to: string): void;
	revert(path: string): void;
	get(path: string): Array<{ path: string; value: JsonValue }>;
	getValue(path: string): JsonValue;
	diff(): DiffOp[];
};

// JSON Schema fragment for a JSONPath input field — reused across tools.
const jsonPathField = {
	type: 'string',
	description: 'A JSONPath expression (RFC 9535) against the current draft.',
} as const;

// JSON Schema fragment for an arbitrary JSON value field.
const jsonValueField = {
	description: 'Any JSON-serializable value: object, array, string, number, boolean, or null.',
} as const;

// Returns a tool set bound to the given engine (or scoped NodeEngine).
// Tools deliberately exclude accept/decline/undo/redo — committing or
// rewinding the draft is the human's decision in v2.
type EphemeralEngineLike = EngineLike & {
	beginEphemeral(): void;
	commitEphemeral(): void;
};

export function createEngineTools(engine: EngineLike, options?: { includeEphemeral?: boolean }): Tool[] {
	const tools: Tool[] = [
		{
			name: 'add',
			description:
				'Add a value at a JSONPath in the draft. Splices into arrays, sets on objects. ' +
				'Creates missing intermediate objects/arrays when the path is literal.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField, value: jsonValueField },
				required: ['path', 'value'],
				additionalProperties: false,
			},
			execute: (input: { path: string; value: JsonValue }) => {
				engine.add(input.path, input.value);
				return { ok: true };
			},
		},
		{
			name: 'replace',
			description: 'Replace the value at a JSONPath in the draft.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField, value: jsonValueField },
				required: ['path', 'value'],
				additionalProperties: false,
			},
			execute: (input: { path: string; value: JsonValue }) => {
				engine.replace(input.path, input.value);
				return { ok: true };
			},
		},
		{
			name: 'delete',
			description: 'Delete the value at a JSONPath from the draft. Removes array elements in place.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField },
				required: ['path'],
				additionalProperties: false,
			},
			execute: (input: { path: string }) => {
				engine.delete(input.path);
				return { ok: true };
			},
		},
		{
			name: 'move',
			description: 'Move a value from one JSONPath to another. Source must resolve to exactly one node.',
			inputSchema: {
				type: 'object',
				properties: {
					from: { ...jsonPathField, description: 'Source JSONPath (must resolve to exactly one node).' },
					to: { ...jsonPathField, description: 'Destination JSONPath.' },
				},
				required: ['from', 'to'],
				additionalProperties: false,
			},
			execute: (input: { from: string; to: string }) => {
				engine.move(input.from, input.to);
				return { ok: true };
			},
		},
		{
			name: 'copy',
			description: 'Copy a value from one JSONPath to another. Source must resolve to exactly one node.',
			inputSchema: {
				type: 'object',
				properties: {
					from: { ...jsonPathField, description: 'Source JSONPath (must resolve to exactly one node).' },
					to: { ...jsonPathField, description: 'Destination JSONPath.' },
				},
				required: ['from', 'to'],
				additionalProperties: false,
			},
			execute: (input: { from: string; to: string }) => {
				engine.copy(input.from, input.to);
				return { ok: true };
			},
		},
		{
			name: 'revert',
			description: 'Revert the value(s) at a JSONPath in the draft back to whatever is in base.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField },
				required: ['path'],
				additionalProperties: false,
			},
			execute: (input: { path: string }) => {
				engine.revert(input.path);
				return { ok: true };
			},
		},
		{
			name: 'get',
			description: 'Query the draft for all values matching a JSONPath. Returns an array of {path, value} entries; empty when nothing matches.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField },
				required: ['path'],
				additionalProperties: false,
			},
			execute: (input: { path: string }) => engine.get(input.path),
		},
		{
			name: 'getValue',
			description:
				'Strict single-match read. Returns the value at the JSONPath if it resolves to exactly one node. ' +
				'Throws an error if the path is ambiguous (multi-match). Throws undefined if no match.',
			inputSchema: {
				type: 'object',
				properties: { path: jsonPathField },
				required: ['path'],
				additionalProperties: false,
			},
			execute: (input: { path: string }) => engine.getValue(input.path),
		},
		{
			name: 'diff',
			description: 'Return the list of structural differences between base and draft as DiffOps.',
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			execute: (_input: Record<string, never>) => engine.diff(),
		},
	];

	if (options?.includeEphemeral) {
		const e = engine as EphemeralEngineLike;
		tools.push(
			{
				name: 'beginEphemeral',
				description:
					'Start an ephemeral session. Subsequent mutations update the draft immediately and ' +
					'are individually undoable within the session, but will be collapsed into a single ' +
					'undo entry when commitEphemeral is called. Use for streaming: call once before the ' +
					'first chunk, replace the target field on each chunk, then call commitEphemeral.',
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
				execute: (_input: Record<string, never>) => { e.beginEphemeral(); return { ok: true }; },
			},
			{
				name: 'commitEphemeral',
				description:
					'End the ephemeral session. All mutations since beginEphemeral are collapsed into ' +
					'one undo entry — the human can undo the entire session in a single step.',
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
				execute: (_input: Record<string, never>) => { e.commitEphemeral(); return { ok: true }; },
			},
		);
	}

	return tools;
}
