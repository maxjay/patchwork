import { describe, it, expect, beforeAll } from 'vitest';
import { Engine } from './engine';
import { diffsEqual, patchworkMatchers } from './testing';

declare module 'vitest' {
	interface Assertion<T = any> {
		toEqualDiff(expected: unknown): T;
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
