import { describe, it, expect, beforeAll } from 'vitest';
import { Engine } from './engine';
import { diffContainsOp, diffsEqual, patchworkMatchers } from './testing';

declare module 'vitest' {
	interface Assertion<T = any> {
		toEqualDiff(expected: unknown): T;
		toContainDiffOp(pattern: unknown): T;
	}
}

beforeAll(() => {
	expect.extend(patchworkMatchers);
});

describe('diffsEqual', () => {
	it('is true for identical diffs', () => {
		const e = new Engine<any>({ x: 1 });
		e.replace('$.x', 2);
		expect(diffsEqual(e.diff(), e.diff())).toBe(true);
	});

	it('is true when only the array order differs', () => {
		const e1 = new Engine<any>({ a: 1, b: 1 });
		e1.replace('$.a', 9);
		e1.replace('$.b', 9);

		const e2 = new Engine<any>({ b: 1, a: 1 }); // built in the opposite key order
		e2.replace('$.a', 9);
		e2.replace('$.b', 9);

		// e1.diff() and e2.diff() may come back in different array order —
		// diffsEqual doesn't care.
		expect(diffsEqual(e1.diff(), e2.diff())).toBe(true);
	});

	it('is false when the actual structural content differs', () => {
		const e = new Engine<any>({ x: 1 });
		e.replace('$.x', 2);
		expect(diffsEqual(e.diff(), [])).toBe(false);
		expect(diffsEqual(e.diff(), [
			{ op: 'replace' as any, path: "$['x']", oldValue: 1, value: 999 },
		])).toBe(false);
	});
});

describe('toEqualDiff matcher', () => {
	it('passes for an order-independent match', () => {
		const e = new Engine<any>({ a: 1, b: 1 });
		e.replace('$.a', 2);
		e.replace('$.b', 2);

		// asserted in the opposite order from how the mutations were made —
		// would fail a plain toEqual() on array order alone
		expect(e.diff()).toEqualDiff([
			{ op: 'replace', path: "$['b']", oldValue: 1, value: 2 },
			{ op: 'replace', path: "$['a']", oldValue: 1, value: 2 },
		]);
	});

	it('fails with a readable message when the diff actually differs', () => {
		const e = new Engine<any>({ x: 1 });
		e.replace('$.x', 2);

		expect(() => {
			expect(e.diff()).toEqualDiff([
				{ op: 'replace', path: "$['x']", oldValue: 1, value: 3 },
			]);
		}).toThrowError(/diff did not match/);
	});

	it('supports .not', () => {
		const e = new Engine<any>({ x: 1 });
		e.replace('$.x', 2);
		expect(e.diff()).not.toEqualDiff([]);
	});
});

describe('diffContainsOp', () => {
	const schema = { type: 'object', properties: { tags: { type: 'array', 'x-key': 'id', items: { type: 'object' } } } };

	it('matches on a subset of fields, ignoring the rest', () => {
		const e = new Engine<any>({ tags: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }] }, { schema });
		e.delete('$.tags[0]');
		const ops = e.diff('$.tags');

		expect(diffContainsOp(ops, { op: 'remove', identity: 1 })).toBe(true);
		// path/value weren't specified in the pattern — irrelevant to the match
		expect(diffContainsOp(ops, { op: 'remove' })).toBe(true);
	});

	it('is false when nothing matches', () => {
		const e = new Engine<any>({ tags: [{ id: 1, label: 'a' }] }, { schema });
		e.delete('$.tags[0]');
		const ops = e.diff('$.tags');
		expect(diffContainsOp(ops, { op: 'add' })).toBe(false);
		expect(diffContainsOp(ops, { op: 'remove', identity: 999 })).toBe(false);
	});
});

describe('toContainDiffOp matcher', () => {
	const schema = { type: 'object', properties: { tags: { type: 'array', 'x-key': 'id', items: { type: 'object' } } } };

	it('passes when a matching op is present among others', () => {
		const e = new Engine<any>({ tags: [{ id: 1 }, { id: 2 }, { id: 3 }] }, { schema });
		e.delete('$.tags[0]');
		e.add('$.tags[-]', { id: 4 });
		e.replace('$.tags[0].id', 2); // no-op-ish churn, just more ops in the diff

		// asserts one specific change happened without enumerating the
		// whole diff — this is exactly what the repo's own
		// engine.array-semantics.test.ts used ops.some(...) + toBe(true) for
		expect(e.diff('$.tags')).toContainDiffOp({ op: 'remove', identity: 1 });
		expect(e.diff('$.tags')).toContainDiffOp({ op: 'add', identity: 4 });
	});

	it('fails with a readable message listing the received ops', () => {
		const e = new Engine<any>({ tags: [{ id: 1 }] }, { schema });
		e.add('$.tags[-]', { id: 2 });

		expect(() => {
			expect(e.diff('$.tags')).toContainDiffOp({ op: 'remove' });
		}).toThrowError(/expected diff to contain an op matching/);
	});
});
