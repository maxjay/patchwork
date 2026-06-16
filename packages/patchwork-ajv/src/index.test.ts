import { describe, it, expect } from 'vitest';
import { createValidator } from './index';

const schema = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		age:  { type: 'number', minimum: 0 },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['name'],
};

describe('createValidator', () => {
	it('returns no errors for valid data', () => {
		const v = createValidator(schema);
		expect(v.validate({ name: 'Alice', age: 30, tags: ['a', 'b'] })).toEqual([]);
	});

	it('returns empty array when optional fields are absent', () => {
		const v = createValidator(schema);
		expect(v.validate({ name: 'Alice' })).toEqual([]);
	});

	it('reports missing required field at root', () => {
		const v = createValidator(schema);
		const errors = v.validate({});
		expect(errors).toContainEqual(
			expect.objectContaining({ path: '$', keyword: 'required', message: expect.stringContaining('name') }),
		);
	});

	it('reports type mismatch with JSONPath to the field', () => {
		const v = createValidator(schema);
		const errors = v.validate({ name: 42 });
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['name']", keyword: 'type' }),
		);
	});

	it('reports minimum violation', () => {
		const v = createValidator(schema);
		const errors = v.validate({ name: 'Alice', age: -5 });
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['age']", keyword: 'minimum' }),
		);
	});

	it('reports nested array item error with index in path', () => {
		const v = createValidator(schema);
		const errors = v.validate({ name: 'Alice', tags: ['ok', 99] });
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['tags'][1]", keyword: 'type' }),
		);
	});

	it('collects all errors when multiple fields are invalid', () => {
		const v = createValidator(schema);
		const errors = v.validate({ name: 42, age: -1 });
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it('reuses the compiled schema across multiple validate calls', () => {
		const v = createValidator(schema);
		expect(v.validate({ name: 'Alice' })).toEqual([]);
		expect(v.validate({})).toHaveLength(1);
		expect(v.validate({ name: 'Bob' })).toEqual([]);
	});
});

describe('createValidator — $ref resolution', () => {
	const refSchema = {
		type: 'object',
		properties: {
			nodes: {
				type: 'array',
				'x-key': 'id',
				items: { $ref: '#/$defs/node' },
			},
		},
		$defs: {
			node: {
				type: 'object',
				required: ['id'],
				properties: {
					id:       { type: 'string' },
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
		const v = createValidator(refSchema);
		expect(v.validate({
			nodes: [{ id: 'a', children: [{ id: 'b', children: [] }] }],
		})).toEqual([]);
	});

	it('reports missing required id in a nested child', () => {
		const v = createValidator(refSchema);
		const errors = v.validate({ nodes: [{ id: 'a', children: [{}] }] });
		expect(errors).toContainEqual(
			expect.objectContaining({ keyword: 'required', message: expect.stringContaining('id') }),
		);
	});

	it('reports type error deep in a recursive tree', () => {
		const v = createValidator(refSchema);
		const errors = v.validate({ nodes: [{ id: 'a', children: [{ id: 42 }] }] });
		expect(errors).toContainEqual(
			expect.objectContaining({ keyword: 'type' }),
		);
	});

	it('ignores x-key and x-ordered vendor extensions without throwing', () => {
		const orderedSchema = {
			type: 'array',
			'x-key': 'id',
			'x-ordered': true,
			items: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
		};
		const v = createValidator(orderedSchema);
		expect(() => v.validate([{ id: 1 }, { id: 2 }])).not.toThrow();
		expect(v.validate([{ id: 'wrong' }])).toContainEqual(
			expect.objectContaining({ keyword: 'type' }),
		);
	});
});
