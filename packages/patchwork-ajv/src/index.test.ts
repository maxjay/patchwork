import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { validate } from './index';

function engine(draft: unknown) { return { draft }; }

const ajv = new Ajv({ strict: false, allErrors: true });

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
		expect(validate(engine({ name: 'Alice', age: 30, tags: ['a'] }), ajv, schema)).toEqual([]);
	});

	it('returns empty array when optional fields are absent', () => {
		expect(validate(engine({ name: 'Alice' }), ajv, schema)).toEqual([]);
	});

	it('reports missing required field at root', () => {
		const errors = validate(engine({}), ajv, schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: '$', keyword: 'required', message: expect.stringContaining('name') }),
		);
	});

	it('reports type mismatch with JSONPath to the field', () => {
		const errors = validate(engine({ name: 42 }), ajv, schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['name']", keyword: 'type' }),
		);
	});

	it('reports minimum violation', () => {
		const errors = validate(engine({ name: 'Alice', age: -1 }), ajv, schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['age']", keyword: 'minimum' }),
		);
	});

	it('reports nested array item error with index in path', () => {
		const errors = validate(engine({ name: 'Alice', tags: ['ok', 99] }), ajv, schema);
		expect(errors).toContainEqual(
			expect.objectContaining({ path: "$['tags'][1]", keyword: 'type' }),
		);
	});

	it('collects all errors with allErrors: true', () => {
		const errors = validate(engine({ name: 42, age: -1 }), ajv, schema);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it('preserves raw Ajv fields alongside path', () => {
		const errors = validate(engine({ name: 42 }), ajv, schema);
		const err = errors[0];
		expect(err).toHaveProperty('instancePath');
		expect(err).toHaveProperty('schemaPath');
		expect(err).toHaveProperty('params');
		expect(err).toHaveProperty('path');
	});
});

describe('validate — user-configured Ajv', () => {
	it('respects $data references when Ajv is configured with $data: true', () => {
		const ajvWithData = new Ajv({ $data: true, allErrors: true, strict: false });
		const dataSchema = {
			type: 'object',
			properties: {
				min: { type: 'number' },
				max: { type: 'number', minimum: { $data: '1/min' } },
			},
		};
		expect(validate(engine({ min: 5, max: 10 }), ajvWithData, dataSchema)).toEqual([]);
		const errors = validate(engine({ min: 5, max: 3 }), ajvWithData, dataSchema);
		expect(errors).toContainEqual(expect.objectContaining({ keyword: 'minimum' }));
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
		expect(validate(engine(draft), ajv, refSchema)).toEqual([]);
	});

	it('reports missing required id in a nested child', () => {
		const errors = validate(engine({ nodes: [{ id: 'a', children: [{}] }] }), ajv, refSchema);
		expect(errors).toContainEqual(
			expect.objectContaining({ keyword: 'required', message: expect.stringContaining('id') }),
		);
	});

	it('reports type error deep in a recursive tree', () => {
		const errors = validate(engine({ nodes: [{ id: 'a', children: [{ id: 42 }] }] }), ajv, refSchema);
		expect(errors).toContainEqual(expect.objectContaining({ keyword: 'type' }));
	});

	it('does not throw on x-key or x-ordered vendor extensions', () => {
		expect(() => validate(engine({ nodes: [{ id: 'a' }] }), ajv, refSchema)).not.toThrow();
	});
});
