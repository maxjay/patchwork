import { describe, it, expect, beforeEach } from 'vitest';
import { DiffOp, Engine } from './engine';

describe('Engine.replace', () => {
	it('replaces a value in an object', () => {
		const e = new Engine({ a: { b: 3 } });
		e.replace('$.a.b', 99);
		expect(e.draft).toEqual({ a: { b: 99 } });
		e.undo();
		expect(e.draft).toEqual({ a: { b: 3 } });
		e.redo();
		expect(e.draft).toEqual({ a: { b: 99 } });
	});

	it('replaces an element in an array', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.replace('$.items[1]', 'X');
		expect(e.draft).toEqual({ items: ['a', 'X', 'c'] });
		e.undo();
		expect(e.draft).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.draft).toEqual({ items: ['a', 'X', 'c'] });
	});

	it('replaces nothing when no path matches query', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.replace('$.otherItems[*]', 0);
		expect(e.draft).toEqual({ items: [1, 2, 3] });
	});

	it('replaces all matching elements with a wildcard', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.replace('$.items[*]', 0);
		expect(e.draft).toEqual({ items: [0, 0, 0] });
		e.undo();
		expect(e.draft).toEqual({ items: [1, 2, 3] });
		e.redo();
		expect(e.draft).toEqual({ items: [0, 0, 0] });
	});
});

describe('Engine.add', () => {
	it('sets a new key on an object', () => {
		const e = new Engine<any>({ a: 1 });
		e.add('$.b', 2);
		expect(e.draft).toEqual({ a: 1, b: 2 });
	});

	it('overwrites an existing object key', () => {
		const e = new Engine({ a: 1 });
		e.add('$.a', 99);
		expect(e.draft).toEqual({ a: 99 });
	});

	it('inserts into an array without removing the existing element', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.add('$.items[1]', 'X');
		expect(e.draft).toEqual({ items: ['a', 'X', 'b', 'c'] });
	});

	it('inserts at index 0, shifting all elements right', () => {
		const e = new Engine({ items: ['a', 'b'] });
		e.add('$.items[0]', 'X');
		expect(e.draft).toEqual({ items: ['X', 'a', 'b'] });
	});

	it('inserts at multiple array positions without corrupting indices', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		// Wildcard matches [0,1,2]; reversing before insert keeps indices stable
		e.add('$.items[*]', 'X');
		expect(e.draft).toEqual({ items: ['X', 'a', 'X', 'b', 'X', 'c'] });
	});

	it('adds nothing when no path matches query', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.add('$.otherItems[*]', 0);
		expect(e.draft).toEqual({ items: [1, 2, 3] });
	});
});

describe('Engine.add (creates missing intermediates)', () => {
	it('creates a missing nested object key', () => {
		const e = new Engine<any>({});
		e.add('$.a.b', 1);
		expect(e.draft).toEqual({ a: { b: 1 } });
		e.undo();
		expect(e.draft).toEqual({});
		e.redo();
		expect(e.draft).toEqual({ a: { b: 1 } });
	});

	it('creates several missing intermediates in one shot', () => {
		const e = new Engine<any>({});
		e.add('$.a.b.c.d', 5);
		expect(e.draft).toEqual({ a: { b: { c: { d: 5 } } } });
		e.undo();
		expect(e.draft).toEqual({});
	});

	it('creates an array when the next segment is an index', () => {
		const e = new Engine<any>({});
		e.add('$.a[0].b', 1);
		expect(e.draft).toEqual({ a: [{ b: 1 }] });
		e.undo();
		expect(e.draft).toEqual({});
	});

	it('mixes existing prefix with fabricated tail', () => {
		const e = new Engine<any>({ a: { b: 3 } });
		e.add('$.a.b.c[0].d', 5);
		expect(e.draft).toEqual({ a: { b: { c: [{ d: 5 }] } } });
	});

	it('undo restores at the divergence point, not the leaf', () => {
		// `b` is a scalar that gets overwritten with an object to make room for c.
		// Undo must put `b` back to 3, not try to surgically remove `c`.
		const e = new Engine<any>({ a: { b: 3 } });
		e.add('$.a.b.c', 5);
		expect(e.draft).toEqual({ a: { b: { c: 5 } } });
		e.undo();
		expect(e.draft).toEqual({ a: { b: 3 } });
		e.redo();
		expect(e.draft).toEqual({ a: { b: { c: 5 } } });
	});

	it('undo removes the top-level key when the whole prefix was fabricated', () => {
		const e = new Engine<any>({ x: 1 });
		e.add('$.a.b.c', 5);
		expect(e.draft).toEqual({ x: 1, a: { b: { c: 5 } } });
		e.undo();
		expect(e.draft).toEqual({ x: 1 });
	});

	it('diff reflects the fabricated subtree as a single add', () => {
		const e = new Engine<any>({});
		e.add('$.a.b', 1);
		expect(e.diff()).toEqual([
			{ op: 'add', path: "$['a']", value: { b: 1 } },
		]);
	});
});

describe('Engine.delete', () => {
	it('removes a key from an object', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.a');
		expect(e.draft).toEqual({ b: 2 });
		e.undo();
		expect(e.draft).toEqual({ a: 1, b: 2 });
		e.redo();
		expect(e.draft).toEqual({ b: 2 });
	});

	it('removes an element from an array', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[1]');
		expect(e.draft).toEqual({ items: ['a', 'c'] });
		e.undo();
		expect(e.draft).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.draft).toEqual({ items: ['a', 'c'] });
	});

	it('removes multiple array elements without index corruption', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[*]');
		expect(e.draft).toEqual({ items: [] });
		e.undo();
		expect(e.draft).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.draft).toEqual({ items: [] });
	});

	it('removes a nested key', () => {
		const e = new Engine<any>({ a: { b: 1, c: 2 } });
		e.delete('$.a.b');
		expect(e.draft).toEqual({ a: { c: 2 } });
		e.undo();
		expect(e.draft).toEqual({ a: { b: 1, c: 2 } });
		e.redo();
		expect(e.draft).toEqual({ a: { c: 2 } });
	});

	it('does nothing when the path matches nothing', () => {
		const e = new Engine({ a: 1 });
		e.delete('$.z');
		expect(e.draft).toEqual({ a: 1 });
		e.undo();
		// State shouldn't change if nothing was deleted
		expect(e.draft).toEqual({ a: 1 });
		e.redo();
		expect(e.draft).toEqual({ a: 1 });
	});
});

describe('Engine.diff', () => {
	it('returns empty array when nothing has changed', () => {
		const e = new Engine({ a: 1 });
		expect(e.diff()).toEqual([]);
	});

	it('detects a replaced scalar', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 2);
		expect(e.diff()).toEqual([
			{ op: 'replace', path: "$['a']", oldValue: 1, value: 2 },
		]);
	});

	it('detects an added key', () => {
		const e = new Engine<any>({ a: 1 });
		e.add('$.b', 2);
		expect(e.diff()).toEqual([
			{ op: 'add', path: "$['b']", value: 2 },
		]);
	});

	it('detects a deleted key', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.b');
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['b']", value: 2 },
		]);
	});

	it('recurses into nested objects', () => {
		const e = new Engine({ a: { b: 1 } });
		e.replace('$.a.b', 2);
		expect(e.diff()).toEqual([
			{ op: 'replace', path: "$['a']['b']", oldValue: 1, value: 2 },
		]);
	});

	it('detects an added array element', () => {
		const e = new Engine({ x: [1, 2] });
		e.add('$.x[2]', 3);
		expect(e.diff()).toEqual([
			{ op: 'add', path: "$['x'][2]", value: 3 },
		]);
	});

	it('detects a removed array element', () => {
		const e = new Engine({ x: [1, 2, 3] });
		e.delete('$.x[2]');
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['x'][2]", value: 3 },
		]);
	});

	it('reflects the original snapshot even after undo', () => {
		const e = new Engine({ a: 1 });
		e.add('$.a', 99);
		e.undo();
		expect(e.diff()).toEqual([]);
	});
});

describe('Engine.revert', () => {
	it('reverts a replaced value back to original', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		expect(e.draft).toEqual({ a: 99 });
		e.revert('$.a');
		expect(e.draft).toEqual({ a: 1 });
		e.undo(); // Undo the revert!
		expect(e.draft).toEqual({ a: 99 });
	});

	it('reverts an added value by deleting it', () => {
		const e = new Engine<any>({ a: 1 });
		e.add('$.b', 2);
		expect(e.draft).toEqual({ a: 1, b: 2 });
		e.revert('$.b');
		expect(e.draft).toEqual({ a: 1 });
	});

	it('reverts a deleted value by restoring it', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.b');
		expect(e.draft).toEqual({ a: 1 });
		e.revert('$.b');
		expect(e.draft).toEqual({ a: 1, b: 2 });
	});

	it('handles wildcard reverts', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.replace('$.items[*]', 0);
		expect(e.draft).toEqual({ items: [0, 0, 0] });
		e.revert('$.items[*]');
		expect(e.draft).toEqual({ items: [1, 2, 3] });
	});
});

describe('Engine.accept', () => {
	it('promotes draft to base', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 2);
		expect(e.base).toEqual({ a: 1 });
		expect(e.draft).toEqual({ a: 2 });
		e.accept();
		expect(e.base).toEqual({ a: 2 });
		expect(e.draft).toEqual({ a: 2 });
	});

	it('undo restores the previous base', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		e.undo(); // undo the accept — base goes back
		e.decline(); // draft resets from base, which is the original
		expect(e.draft).toEqual({ a: 1 });
	});

	it('redo re-applies the accept', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		e.undo();
		e.redo();
		e.decline(); // base is back to { a: 2 }, so draft resets to that
		expect(e.draft).toEqual({ a: 2 });
	});
});

describe('Engine.decline', () => {
	it('resets draft from the current base', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		e.replace('$.a', 99);
		e.decline();
		expect(e.draft).toEqual({ a: 2 });
		expect(e.base).toEqual({ a: 2 });
	});

	it('resets draft to base when nothing has been accepted', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 99);
		e.decline();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('resets to the most recently accepted base', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		e.replace('$.a', 3);
		e.accept();
		e.replace('$.a', 99);
		e.decline();
		expect(e.draft).toEqual({ a: 3 });
	});

	it('undo restores the declined draft', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 99);
		e.decline();
		expect(e.draft).toEqual({ a: 1 });
		e.undo(); // undo the decline
		expect(e.draft).toEqual({ a: 99 });
	});

	it('redo re-applies the decline', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 99);
		e.decline();
		e.undo();
		e.redo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('is a no-op when draft already equals base', () => {
		const e = new Engine({ a: 1 });
		e.decline();
		expect(e.draft).toEqual({ a: 1 });
		expect(e.base).toEqual({ a: 1 });
	});
});

describe('Engine.move', () => {
	it('moves a value from one path to another', () => {
		const e = new Engine<any>({ a: { b: 3 }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: {}, x: 3 });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 3 }, x: 0 });
	});

	it('moves an object from one path to another', () => {
		const e = new Engine<any>({ a: { b: { foo: 'bar' } }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: {}, x: { foo: 'bar' } });

		e.undo();
		expect(e.draft).toEqual({ a: { b: { foo: 'bar' } }, x: 0 });
	});

	it('moves an array element from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b[1]', '$.x');
		expect(e.draft).toEqual({ a: { b: [3, 5] }, x: 4 });

		e.undo();
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves an array from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: {}, x: [3, 4, 5] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves item to end of an array', () => {
		const e = new Engine<any>({ a: { b: 6 }, x: [3, 4, 5] });
		e.move('$.a.b', '$.x[3]');
		expect(e.draft).toEqual({ a: {}, x: [3, 4, 5, 6] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 6 }, x: [3, 4, 5] });
	});

	it('moves one source value into multiple normalized target paths', () => {
		const e = new Engine({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
		e.move('$.a.b', '$.items[*].x');
		expect(e.draft).toEqual({ a: {}, items: [{ x: 1 }, { x: 1 }] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
	});

	it('throws when from path resolves to more than one path', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		expect(() => e.move('$.items[*].id', '$.value')).toThrow('Move source must resolve to exactly one path');
	});

	it('throws when moving a path into one of its own descendants', () => {
		const e = new Engine({ a: { b: { c: 1 } } });
		expect(() => e.move('$.a.b', '$.a.b.c.d')).toThrow('Invalid move target: cannot move a path into one of its own descendants');
	});
});

describe('Engine.copy', () => {
	it('copies a value from one path to another', () => {
		const e = new Engine<any>({ a: { b: 3 }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: { b: 3 }, x: 3 });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 3 }, x: 0 });
	});

	it('copies an object from one path to another', () => {
		const e = new Engine<any>({ a: { b: { foo: 'bar' } }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: { b: { foo: 'bar' } }, x: { foo: 'bar' } });

		e.undo();
		expect(e.draft).toEqual({ a: { b: { foo: 'bar' } }, x: 0 });
	});

	it('copies an array element from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.copy('$.a.b[1]', '$.x');
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: 4 });

		e.undo();
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('copies an array from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: [3, 4, 5] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('copies item to end of an array', () => {
		const e = new Engine<any>({ a: { b: 6 }, x: [3, 4, 5] });
		e.copy('$.a.b', '$.x[3]');
		expect(e.draft).toEqual({ a: { b: 6 }, x: [3, 4, 5, 6] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 6 }, x: [3, 4, 5] });
	});

	it('copies one source value into multiple normalized target paths', () => {
		const e = new Engine({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
		e.copy('$.a.b', '$.items[*].x');
		expect(e.draft).toEqual({ a: { b: 1 }, items: [{ x: 1 }, { x: 1 }] });

		e.undo();
		expect(e.draft).toEqual({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
	});

	it('throws when from path resolves to more than one path', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		expect(() => e.copy('$.items[*].id', '$.value')).toThrow('Copy source must resolve to exactly one path');
	});

	it('allows copying a path into one of its own descendants', () => {
		const e = new Engine({ a: { b: { c: 1 } } });
		e.copy('$.a.b', '$.a.b.x');
		expect(e.draft).toEqual({ a: { b: { c: 1, x: { c: 1 } } } });

		e.undo();
		expect(e.draft).toEqual({ a: { b: { c: 1 } } });
	});
});

describe('Engine.exportChanges', () => {
	it('exports the list of changes as a JSON Patch array', () => {
		const e = new Engine({ a: 1, items: ['x', 'y'], copyTargets: { foo: 0, bar: 0} });
		e.replace('$.a', 2);
		e.add('$.b', 3);
		e.move('$.items[0]', '$.items[2]');
		e.delete('$.items[0]');
		e.copy('$.a', '$.copyTargets.*');
		e.revert('$.a');

		expect(e.draft).toEqual({ a: 1, b: 3, items: ['x'], copyTargets: { foo: 2, bar: 2 } });

		expect(e.exportChanges()).toEqual([
			{ op: 'replace', path: "$.a", value: 2 },
			{ op: 'add', path: "$.b", value: 3 },
			{ op: 'move', from: "$.items[0]", to: "$.items[2]" },
			{ op: 'remove', path: "$.items[0]" },
			{ op: 'copy', from: "$.a", to: "$.copyTargets.*" },
			{ op: 'revert', path: "$.a" },
		]);
	});
});

describe('Engine.importChanges', () => {
	it('applies a list of changes in JSON Patch format', () => {
		const e = new Engine({ a: 6, items: ['a', 'b'], copyTargets: { foo: 100, bar: 100} });
		const changes = [
			{ op: 'replace', path: "$.a", value: 2 },
			{ op: 'add', path: "$.b", value: 3 },
			{ op: 'move', from: "$.items[0]", to: "$.items[2]" },
			{ op: 'remove', path: "$.items[0]" },
			{ op: 'copy', from: "$.a", to: "$.copyTargets.*" },
			{ op: 'revert', path: "$.a" },
		] as DiffOp[];
		e.importChanges(changes);

		expect(e.draft).toEqual({ a: 6, b: 3, items: ['a'], copyTargets: { foo: 2, bar: 2 } });
	});
});

describe('Engine.get', () => {
	it('returns an array of {path, value} for a literal path', () => {
		const e = new Engine({ a: { b: 3 } });
		expect(e.get('$.a.b')).toEqual([
			{ path: "$['a']['b']", value: 3 },
		]);
	});

	it('returns multiple matches for a wildcard', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		expect(e.get('$.items[*]')).toEqual([
			{ path: "$['items'][0]", value: 'a' },
			{ path: "$['items'][1]", value: 'b' },
			{ path: "$['items'][2]", value: 'c' },
		]);
	});

	it('returns an empty array when nothing matches', () => {
		const e = new Engine({ a: 1 });
		expect(e.get('$.missing')).toEqual([]);
	});

	it('reads from draft, not base', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		expect(e.get('$.a')).toEqual([{ path: "$['a']", value: 99 }]);
	});

	it('supports filter expressions across collections', () => {
		const e = new Engine({
			cars: [{ color: 'red' }, { color: 'blue' }],
			trucks: [{ color: 'red' }, { color: 'green' }],
		});
		const reds = e.get('$..*[?@.color == "red"]');
		expect(reds).toHaveLength(2);
		expect(reds.map(r => r.value)).toEqual(
			expect.arrayContaining([
				{ color: 'red' },
				{ color: 'red' },
			]),
		);
	});
});

describe('Engine.getValue', () => {
	it('returns the value at a single matching path', () => {
		const e = new Engine({ a: { b: 3 } });
		expect(e.getValue('$.a.b')).toBe(3);
	});

	it('returns nested objects directly (not wrapped)', () => {
		const e = new Engine({ server: { host: 'localhost', port: 8080 } });
		expect(e.getValue('$.server')).toEqual({ host: 'localhost', port: 8080 });
	});

	it('reads from draft', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		expect(e.getValue('$.a')).toBe(99);
	});

	it('throws undefined when the path resolves to no value', () => {
		const e = new Engine({ a: 1 });
		let thrown: unknown = 'sentinel';
		try { e.getValue('$.missing'); } catch (err) { thrown = err; }
		expect(thrown).toBeUndefined();
	});

	it('throws an Error when the path resolves to multiple values', () => {
		const e = new Engine({ items: [1, 2, 3] });
		expect(() => e.getValue('$.items[*]')).toThrow();
	});
});

// A child engine is a scoped lens onto a sub-path of a parent engine. The
// parent owns the underlying base/draft and the undo stack; the child reads
// and writes through the parent. Mutations through the child are visible in
// the parent (and vice versa) because they're the same physical state — the
// child is not a copy.
//
// Open design questions captured by this suite:
//   - Undo: shared with parent. cars.undo() pops the parent's stack and
//     reverses whatever was last done — even if that was through engine,
//     not cars. This keeps history linear; a per-child stack would split
//     history in confusing ways.
//   - Accept/decline: act on the child's subtree only. cars.accept() snapshots
//     only the cars subtree of draft into the cars subtree of base.
//   - Diff: scoped to the child. cars.diff() returns ops with paths relative
//     to the child's root ($), not the parent's.
//   - Multi-match paths (e.g. $.cars[*]): getNodeEngine throws — a child must
//     resolve to a single concrete subtree.
describe('Engine nesting (proposed)', () => {
	it('getNodeEngine returns a child rooted at the given path', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }, { color: 'blue' }],
			trucks: [{ color: 'red' }, { color: 'green' }],
		});

		const cars = engine.getNodeEngine('$.cars');
		expect(cars.draft).toEqual([{ color: 'red' }, { color: 'blue' }]);
		expect(cars.base).toEqual([{ color: 'red' }, { color: 'blue' }]);

		const trucks = engine.getNodeEngine('$.trucks');
		expect(trucks.draft).toEqual([{ color: 'red' }, { color: 'green' }]);
	});

	it('mutations through child are visible in parent', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		cars.replace('$[0].color', 'yellow');

		expect(engine.draft).toEqual({
			cars: [{ color: 'yellow' }],
			trucks: [{ color: 'red' }],
		});
		expect(cars.draft).toEqual([{ color: 'yellow' }]);
	});

	it('mutations through parent are visible in child', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		engine.replace('$.cars[0].color', 'purple');

		expect(cars.draft).toEqual([{ color: 'purple' }]);
	});

	it('child stays attached even when the parent reassigns the parent path', () => {
		const engine = new Engine<any>({ cars: [{ color: 'red' }] });
		const cars = engine.getNodeEngine('$.cars');

		// wholesale replace of the cars subtree from the parent
		engine.replace('$.cars', [{ color: 'blue' }]);

		expect(cars.draft).toEqual([{ color: 'blue' }]);
	});

	it('undo through child shares history with parent', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		cars.replace('$[0].color', 'blue');
		expect(engine.draft.cars[0].color).toBe('blue');

		// undo through the child — parent sees the rollback
		cars.undo();
		expect(engine.draft.cars[0].color).toBe('red');

		// undo through parent reverses what the child did, too
		cars.replace('$[0].color', 'green');
		engine.undo();
		expect(cars.draft[0].color).toBe('red');
	});

	it('accept on a child scopes to its subtree', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		cars.replace('$[0].color', 'yellow');
		engine.replace('$.trucks[0].color', 'orange');

		cars.accept(); // commits ONLY the cars subtree

		expect(engine.base).toEqual({
			cars: [{ color: 'yellow' }],
			trucks: [{ color: 'red' }], // not committed
		});
		expect(engine.draft).toEqual({
			cars: [{ color: 'yellow' }],
			trucks: [{ color: 'orange' }], // still pending
		});
	});

	it('diff on a child is scoped to its subtree', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'red' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		cars.replace('$[0].color', 'blue');
		engine.replace('$.trucks[0].color', 'green');

		// parent sees both changes
		expect(engine.diff()).toHaveLength(2);

		// child sees only its own, with paths relative to its root
		expect(cars.diff()).toEqual([
			{ op: 'replace', path: "$[0]['color']", oldValue: 'red', value: 'blue' },
		]);
	});

	it('get returns matching values across the whole document', () => {
		const engine = new Engine({
			cars: [{ color: 'red', model: 'sedan' }, { color: 'blue', model: 'suv' }],
			trucks: [{ color: 'red', model: 'pickup' }, { color: 'green', model: 'box' }],
		});

		const reds = engine.get('$..*[?@.color == "red"]');
		expect(reds).toHaveLength(2);
		expect(reds.map(r => r.value)).toEqual(expect.arrayContaining([
			{ color: 'red', model: 'sedan' },
			{ color: 'red', model: 'pickup' },
		]));
	});

	it('get on a child scopes to that subtree', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }, { color: 'blue' }],
			trucks: [{ color: 'red' }, { color: 'green' }],
		});
		const cars = engine.getNodeEngine('$.cars');

		const reds = cars.get('$[?@.color == "red"]');
		expect(reds.map(r => r.value)).toEqual([{ color: 'red' }]); // no trucks
	});

	it('getNodeEngine throws when the path does not resolve to exactly one node', () => {
		const engine = new Engine({ cars: [{}, {}] });
		expect(() => engine.getNodeEngine('$.cars[*]')).toThrow();
		expect(() => engine.getNodeEngine('$.missing')).toThrow();
	});
});
describe('Engine.ephemeral', () => {
	it('mutations during session update draft normally', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 2);
		expect(e.draft).toEqual({ a: 2 });
	});

	it('mutations during session are individually undoable', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 2);
		e.replace('$.a', 3);
		e.undo();
		expect(e.draft).toEqual({ a: 2 });
		e.undo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('undo at session boundary is a no-op', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 5);
		e.beginEphemeral();
		e.undo(); // no-op — nothing in session yet
		expect(e.draft).toEqual({ a: 5 });
	});

	it('commitEphemeral collapses session into one undo step', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 2);
		e.replace('$.a', 3);
		e.replace('$.a', 4);
		e.commitEphemeral();
		e.undo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('commitEphemeral: redo re-applies the committed state', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 99);
		e.commitEphemeral();
		e.undo();
		e.redo();
		expect(e.draft).toEqual({ a: 99 });
	});

	it('discardEphemeral restores pre-session draft', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 2);
		e.replace('$.a', 3);
		e.discardEphemeral();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('discardEphemeral leaves no stack entry', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 5);
		const countBefore = e.exportChanges().length;
		e.beginEphemeral();
		e.replace('$.a', 99);
		e.discardEphemeral();
		expect(e.exportChanges().length).toBe(countBefore);
		e.undo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('pre-session operations still undoable after commitEphemeral', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 5);
		e.beginEphemeral();
		e.replace('$.a', 99);
		e.commitEphemeral();
		e.undo();
		e.undo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('pre-session operations still undoable after discardEphemeral', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 5);
		e.beginEphemeral();
		e.replace('$.a', 99);
		e.discardEphemeral();
		e.undo();
		expect(e.draft).toEqual({ a: 1 });
	});

	it('diff() reflects ephemeral changes during session', () => {
		const e = new Engine({ a: 1 });
		e.beginEphemeral();
		e.replace('$.a', 99);
		expect(e.diff()).toEqual([
			{ op: 'replace', path: "$['a']", oldValue: 1, value: 99 },
		]);
	});

	it('exportChanges after commitEphemeral does not include the consolidated op', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 5);
		const countBefore = e.exportChanges().length;
		e.beginEphemeral();
		e.replace('$.a', 99);
		e.replace('$.a', 100);
		e.commitEphemeral();
		expect(e.exportChanges().length).toBe(countBefore);
	});

	it('beginEphemeral throws if already in a session', () => {
		const e = new Engine({});
		e.beginEphemeral();
		expect(() => e.beginEphemeral()).toThrow();
	});

	it('commitEphemeral throws if not in a session', () => {
		const e = new Engine({});
		expect(() => e.commitEphemeral()).toThrow();
	});

	it('discardEphemeral throws if not in a session', () => {
		const e = new Engine({});
		expect(() => e.discardEphemeral()).toThrow();
	});

	it('streaming: many replaces collapse to one undo', () => {
		const e = new Engine({ response: '' });
		e.beginEphemeral();
		for (const chunk of ['h', 'he', 'hel', 'hell', 'hello']) {
			e.replace('$.response', chunk);
		}
		e.commitEphemeral();
		expect(e.draft).toEqual({ response: 'hello' });
		e.undo();
		expect(e.draft).toEqual({ response: '' });
		e.redo();
		expect(e.draft).toEqual({ response: 'hello' });
	});

	it('NodeEngine mutations during parent session are collapsed by commitEphemeral', () => {
		const e = new Engine<any>({ cars: [{ color: 'red' }], trucks: [{ color: 'red' }] });
		const cars = e.getNodeEngine('$.cars');
		e.beginEphemeral();
		cars.replace('$[0].color', 'blue');
		cars.replace('$[0].color', 'green');
		e.commitEphemeral();
		expect(e.draft.cars[0].color).toBe('green');
		e.undo();
		expect(e.draft.cars[0].color).toBe('red');
		expect(e.draft.trucks[0].color).toBe('red');
	});

	it('NodeEngine mutations during parent session are rolled back by discardEphemeral', () => {
		const e = new Engine<any>({ cars: [{ color: 'red' }] });
		const cars = e.getNodeEngine('$.cars');
		e.beginEphemeral();
		cars.replace('$[0].color', 'blue');
		e.discardEphemeral();
		expect(e.draft.cars[0].color).toBe('red');
	});
});
