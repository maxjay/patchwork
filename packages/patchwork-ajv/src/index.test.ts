import { describe, it, expect } from 'vitest';
import { validate } from './index';

// Minimal Engine stand-in — just needs a draft property.
function engine(draft: unknown) { return { draft }; }

const schema = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		age:  { type: 'number', minimum: 0 },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['name'],
};

describe('validate', () => {
	it('returns empty array for valid draft', () => {
		expect(validate(engine({ name: 'Alice', age: 30, tags: ['a'] }), schema)).toEqual([]);
	});

	it('returns empty array when optional fields are absent', () => {
		expect(validate(engine({ name: 'Alice' }), schema)).toEqual([]);
	});

	it('reports missing required field at root', () => {
		const errors = validate(engine({}), schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: '$', keyword: 'required', message: expect.stringContaining('name') }),
		);
	});

	it('reports type mismatch with JSONPath to the field', () => {
		const errors = validate(engine({ name: 42 }), schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['name']", keyword: 'type' }),
		);
	});

	it('reports minimum violation', () => {
		const errors = validate(engine({ name: 'Alice', age: -1 }), schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['age']", keyword: 'minimum' }),
		);
	});

	it('reports nested array item error with index in path', () => {
		const errors = validate(engine({ name: 'Alice', tags: ['ok', 99] }), schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['tags'][1]", keyword: 'type' }),
		);
	});

	it('collects all errors with allErrors: true', () => {
		const errors = validate(engine({ name: 42, age: -1 }), schema);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it('preserves raw Ajv fields alongside path', () => {
		const errors = validate(engine({ name: 42 }), schema);
		const err = errors[0];
		expect(err).toHaveProperty('instancePath');
		expect(err).toHaveProperty('schemaPath');
		expect(err).toHaveProperty('params');
		expect(err).toHaveProperty('path');
	});
});

describe('validate — $ref and vendor extensions', () => {
	const refSchema = {
		type: 'object',
		properties: {
			nodes: {
				type: 'array',
				'x-key': 'id',
				'x-ordered': true,
				items: { $ref: '#/$defs/node' },
			},
		},
		$defs: {
			node: {
				type: 'object',
				required: ['id'],
				properties: {
					id: { type: 'string' },
					children: {
						type: 'array',
						'x-key': 'id',
						items: { $ref: '#/$defs/node' },
					},
				},
			},
		},
	};

	it('validates a valid recursive tree with no errors', () => {
		const draft = { nodes: [{ id: 'a', children: [{ id: 'b', children: [] }] }] };
		expect(validate(engine(draft), refSchema)).toEqual([]);
	});

	it('reports missing required id in a nested child', () => {
		const errors = validate(engine({ nodes: [{ id: 'a', children: [{}] }] }), refSchema);
		expect(errors).toContainEqual(
			expect.objectContaining({ keyword: 'required', message: expect.stringContaining('id') }),
		);
	});

	it('reports type error deep in a recursive tree', () => {
		const errors = validate(engine({ nodes: [{ id: 'a', children: [{ id: 42 }] }] }), refSchema);
		expect(errors).toContainEqual(expect.objectContaining({ keyword: 'type' }));
	});

	it('does not throw on x-key or x-ordered vendor extensions', () => {
		expect(() => validate(engine({ nodes: [{ id: 'a' }] }), refSchema)).not.toThrow();
	});
});
