import { describe, it, expect } from 'vitest';
import { Engine } from './engine';
import { createEngineTools, type Tool } from './tools';

function toolByName(tools: Tool[], name: string): Tool {
	const t = tools.find(x => x.name === name);
	if (!t) throw new Error(`Tool not found: ${name}`);
	return t;
}

describe('createEngineTools', () => {
	it('exposes the documented 9 tools in order', () => {
		const e = new Engine({});
		const tools = createEngineTools(e);
		expect(tools.map(t => t.name)).toEqual([
			'add', 'replace', 'delete', 'move', 'copy', 'revert',
			'get', 'getValue', 'diff',
		]);
	});

	it('does not expose accept, decline, undo, or redo', () => {
		const e = new Engine({});
		const names = createEngineTools(e).map(t => t.name);
		expect(names).not.toContain('accept');
		expect(names).not.toContain('decline');
		expect(names).not.toContain('undo');
		expect(names).not.toContain('redo');
	});
});

describe('createEngineTools — mutating tools', () => {
	it('add mutates the draft', () => {
		const e = new Engine<any>({ a: 1 });
		toolByName(createEngineTools(e), 'add').execute({ path: '$.b', value: 2 });
		expect(e.draft).toEqual({ a: 1, b: 2 });
	});

	it('replace mutates the draft', () => {
		const e = new Engine({ a: 1 });
		toolByName(createEngineTools(e), 'replace').execute({ path: '$.a', value: 99 });
		expect(e.draft).toEqual({ a: 99 });
	});

	it('delete mutates the draft', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		toolByName(createEngineTools(e), 'delete').execute({ path: '$.b' });
		expect(e.draft).toEqual({ a: 1 });
	});

	it('move mutates the draft', () => {
		const e = new Engine<any>({ a: 1 });
		toolByName(createEngineTools(e), 'move').execute({ from: '$.a', to: '$.b' });
		expect(e.draft).toEqual({ b: 1 });
	});

	it('copy mutates the draft', () => {
		const e = new Engine<any>({ a: 1 });
		toolByName(createEngineTools(e), 'copy').execute({ from: '$.a', to: '$.b' });
		expect(e.draft).toEqual({ a: 1, b: 1 });
	});

	it('revert mutates the draft back to base', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		toolByName(createEngineTools(e), 'revert').execute({ path: '$.a' });
		expect(e.draft).toEqual({ a: 1 });
	});
});

describe('createEngineTools — read tools', () => {
	it('get returns matching {path, value} entries from the draft', () => {
		const e = new Engine({ items: ['x', 'y'] });
		const out = toolByName(createEngineTools(e), 'get').execute({ path: '$.items[*]' });
		expect(out).toEqual([
			{ path: "$['items'][0]", value: 'x' },
			{ path: "$['items'][1]", value: 'y' },
		]);
	});

	it('getValue returns the single matching value', () => {
		const e = new Engine({ a: { b: 3 } });
		expect(toolByName(createEngineTools(e), 'getValue').execute({ path: '$.a.b' })).toBe(3);
	});

	it('getValue throws Error on multi-match', () => {
		const e = new Engine({ items: [1, 2, 3] });
		expect(() => toolByName(createEngineTools(e), 'getValue').execute({ path: '$.items[*]' })).toThrow();
	});

	it('getValue throws undefined on no match', () => {
		const e = new Engine({ a: 1 });
		let thrown: unknown = 'sentinel';
		try { toolByName(createEngineTools(e), 'getValue').execute({ path: '$.missing' }); }
		catch (err) { thrown = err; }
		expect(thrown).toBeUndefined();
	});

	it('diff returns the current DiffOps', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		const out = toolByName(createEngineTools(e), 'diff').execute({});
		expect(out).toEqual([
			{ op: 'replace', path: "$['a']", oldValue: 1, value: 99 },
		]);
	});
});

describe('createEngineTools — NodeEngine scoping', () => {
	it('tools bound to a child only mutate that subtree', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');
		const tools = createEngineTools(cars);

		toolByName(tools, 'replace').execute({ path: '$[0].color', value: 'blue' });

		expect(engine.draft).toEqual({
			cars: [{ color: 'blue' }],
			trucks: [{ color: 'red' }], // untouched
		});
	});

	it('get on a child-bound tool returns paths in the child frame', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');
		const out = toolByName(createEngineTools(cars), 'get').execute({ path: '$[*]' });
		expect(out).toEqual([
			{ path: '$[0]', value: { color: 'red' } },
		]);
	});
});

describe('createEngineTools — schema shape', () => {
	it('add tool input schema matches expected JSON Schema', () => {
		const e = new Engine({});
		const add = toolByName(createEngineTools(e), 'add');
		expect(add.inputSchema).toMatchObject({
			type: 'object',
			properties: {
				path: { type: 'string' },
				value: {},
			},
			required: ['path', 'value'],
			additionalProperties: false,
		});
	});

	it('diff tool input schema accepts an empty object', () => {
		const e = new Engine({});
		const diff = toolByName(createEngineTools(e), 'diff');
		expect(diff.inputSchema).toMatchObject({
			type: 'object',
			properties: {},
			additionalProperties: false,
		});
	});
});
