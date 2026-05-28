import { describe, it, expect, beforeEach } from 'vitest';
import { DiffOp, Engine, type KeyedGetResult } from './engine';

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

describe('Engine.getBase', () => {
	it('reads from base, not draft', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		expect(e.get('$.a')).toEqual([{ path: "$['a']", value: 99 }]);
		expect(e.getBase('$.a')).toEqual([{ path: "$['a']", value: 1 }]);
	});

	it('supports wildcards against base', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.replace('$.items[0]', 'z');
		expect(e.getBase('$.items[*]')).toEqual([
			{ path: "$['items'][0]", value: 'a' },
			{ path: "$['items'][1]", value: 'b' },
			{ path: "$['items'][2]", value: 'c' },
		]);
	});

	it('returns empty array when nothing matches in base', () => {
		const e = new Engine({ a: 1 });
		expect(e.getBase('$.missing')).toEqual([]);
	});

	it('reflects base after accept()', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		expect(e.getBase('$.a')).toEqual([{ path: "$['a']", value: 2 }]);
		expect(e.get('$.a')).toEqual([{ path: "$['a']", value: 2 }]);
	});
});

describe('Engine.getValueBase', () => {
	it('reads from base, not draft', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 99);
		expect(e.getValueBase('$.a')).toBe(1);
	});

	it('throws undefined when the path resolves to no value in base', () => {
		const e = new Engine({ a: 1 });
		let thrown: unknown = 'sentinel';
		try { e.getValueBase('$.missing'); } catch (err) { thrown = err; }
		expect(thrown).toBeUndefined();
	});

	it('throws an Error when the path resolves to multiple values in base', () => {
		const e = new Engine({ items: [1, 2, 3] });
		expect(() => e.getValueBase('$.items[*]')).toThrow();
	});

	it('reflects base after accept()', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 2);
		e.accept();
		expect(e.getValueBase('$.a')).toBe(2);
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
//     to the child's root ($), plus absolutePath for the full document path.
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

		// child sees only its own changes; path is relative, absolutePath is the full document path
		expect(cars.diff()).toEqual([
			{ op: 'replace', path: "$[0]['color']", absolutePath: "$['cars'][0]['color']", oldValue: 'red', value: 'blue' },
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

	it('getBase on a child reads from parent base, paths rebased to child frame', () => {
		const engine = new Engine({
			cars: [{ color: 'red' }, { color: 'blue' }],
		});
		const cars = engine.getNodeEngine('$.cars');
		engine.replace('$.cars[0].color', 'yellow');

		expect(cars.get('$[0].color')).toEqual([{ path: "$[0]['color']", value: 'yellow' }]);
		expect(cars.getBase('$[0].color')).toEqual([{ path: "$[0]['color']", value: 'red' }]);
	});

	it('getValueBase on a child reads committed value from parent base', () => {
		const engine = new Engine({ cars: [{ color: 'red' }] });
		const cars = engine.getNodeEngine('$.cars');
		engine.replace('$.cars[0].color', 'yellow');

		expect(cars.getValue('$[0].color')).toBe('yellow');
		expect(cars.getValueBase('$[0].color')).toBe('red');
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

describe('Engine.diff — scoped', () => {
	it('diff() without args returns full diff', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.replace('$.a', 9);
		e.replace('$.b', 9);
		expect(e.diff()).toHaveLength(2);
	});

	it('diff(path) filters to ops under the matched prefix', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.replace('$.a', 9);
		e.replace('$.b', 9);
		expect(e.diff('$.a')).toEqual([
			{ op: 'replace', path: "$['a']", oldValue: 1, value: 9 },
		]);
	});

	it('diff(path) includes ops for deleted nodes not present in draft', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.a');
		expect(e.diff('$.a')).toEqual([
			{ op: 'remove', path: "$['a']", value: 1 },
		]);
	});

	it('diff(path) includes ops for added nodes not present in base', () => {
		const e = new Engine<any>({ b: 2 });
		e.add('$.a', 1);
		expect(e.diff('$.a')).toEqual([
			{ op: 'add', path: "$['a']", value: 1 },
		]);
	});

	it('diff(path) with wildcard returns ops for all matching elements', () => {
		const e = new Engine<any>({ items: [1, 2, 3] });
		e.replace('$.items[0]', 9);
		e.replace('$.items[2]', 9);
		expect(e.diff('$.items[*]')).toHaveLength(2);
	});

	it('diff(path) returns empty array when path matches nothing in base or draft', () => {
		const e = new Engine<any>({ a: 1 });
		e.replace('$.a', 9);
		expect(e.diff('$.missing')).toEqual([]);
	});

	it('diff(path) returns nested ops under a matched subtree', () => {
		const e = new Engine<any>({ server: { host: 'a', port: 80 }, debug: false });
		e.replace('$.server.port', 443);
		e.replace('$.debug', true);
		expect(e.diff('$.server')).toEqual([
			{ op: 'replace', path: "$['server']['port']", oldValue: 80, value: 443 },
		]);
	});
});

describe('Engine — identity-keyed array diff', () => {
	const schema = {
		type: 'object',
		properties: {
			items: { type: 'array', 'x-key': 'id', items: { type: 'object' } },
		},
	};

	it('delete by key emits one remove, not cascading replaces', () => {
		const e = new Engine({ items: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }] }, { schema });
		e.delete('$.items[0]');
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['items'][0]", value: { id: 1, v: 'a' }, identity: 1 },
		]);
	});

	it('add by key emits one add op', () => {
		const e = new Engine<any>({ items: [{ id: 1 }] }, { schema });
		e.add('$.items[1]', { id: 2, v: 'new' });
		expect(e.diff()).toEqual([
			{ op: 'add', path: "$['items'][1]", value: { id: 2, v: 'new' }, identity: 2 },
		]);
	});

	it('edit within element emits replace on the changed field only', () => {
		const e = new Engine({ items: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] }, { schema });
		e.replace('$.items[0].v', 'z');
		expect(e.diff()).toEqual([
			{ op: 'replace', path: "$['items'][0]['v']", oldValue: 'a', value: 'z' },
		]);
	});

	it('without schema falls back to index-based diff', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		e.delete('$.items[0]');
		expect(e.diff()).toHaveLength(2);
	});

	it('per-call key override', () => {
		const e = new Engine({ items: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] });
		e.delete('$.items[0]');
		expect(e.diff('$.items', { key: 'id' })).toEqual([
			{ op: 'remove', path: "$['items'][0]", value: { id: 1, v: 'a' }, identity: 1 },
		]);
	});

	it('nested x-key via schema items', () => {
		const nestedSchema = {
			type: 'object',
			properties: {
				groups: {
					type: 'array', 'x-key': 'gid',
					items: {
						type: 'object',
						properties: {
							members: { type: 'array', 'x-key': 'uid', items: { type: 'object' } },
						},
					},
				},
			},
		};
		const e = new Engine(
			{ groups: [{ gid: 1, members: [{ uid: 10 }, { uid: 20 }] }] },
			{ schema: nestedSchema },
		);
		e.delete('$.groups[0].members[0]');
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['groups'][0]['members'][0]", value: { uid: 10 }, identity: 10 },
		]);
	});

	it('NodeEngine.diff() includes absolutePath alongside relative path', () => {
		const e = new Engine<any>({ items: [{ id: 1, v: 'a' }] }, { schema });
		const lens = e.getNodeEngine('$.items');
		e.replace('$.items[0].v', 'z');
		expect(lens.diff()).toEqual([
			{ op: 'replace', path: "$[0]['v']", absolutePath: "$['items'][0]['v']", oldValue: 'a', value: 'z' },
		]);
	});

	it('identity disambiguates remove from internal-change when both land on the same index', () => {
		// base: [p1(0), p2(1), p3(2)] — delete p2, change p3.v
		// After delete: p3 shifts to draft[1]. The remove for p2 uses base index 1;
		// the replace for p3.v uses draft index 1. Without identity they look identical.
		const e = new Engine<any>(
			{ items: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }] },
			{ schema },
		);
		e.delete('$.items[1]');
		e.replace('$.items[1].v', 'z'); // items[1] in draft is now id:3
		const ops = e.diff();
		const removeOp = ops.find(o => o.op === 'remove');
		const replaceOp = ops.find(o => o.op === 'replace');
		expect(removeOp).toMatchObject({ op: 'remove', value: { id: 2, v: 'b' }, identity: 2 });
		expect(replaceOp).toMatchObject({ op: 'replace', value: 'z' });
		// identity is only on the element-level remove, not on the field-level replace
		expect((replaceOp as any).identity).toBeUndefined();
	});

	it('nested: deleting a child emits identity; parent path is navigable in draft', () => {
		const nestedSchema = {
			type: 'object',
			properties: {
				groups: {
					type: 'array', 'x-key': 'id',
					items: {
						type: 'object',
						properties: {
							members: { type: 'array', 'x-key': 'id', items: { type: 'object' } },
						},
					},
				},
			},
		};
		const e = new Engine<any>({
			groups: [
				{ id: 'p1', label: 'Group A', members: [{ id: 's1', label: 'Alpha' }, { id: 's2', label: 'Beta' }] },
				{ id: 'p2', label: 'Group B', members: [] },
			],
		}, { schema: nestedSchema });

		e.delete('$.groups[0].members[0]');

		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['groups'][0]['members'][0]", value: { id: 's1', label: 'Alpha' }, identity: 's1' },
		]);
	});
});

describe('Engine — $self set diff', () => {
	const schema = {
		type: 'object',
		properties: {
			tags: { type: 'array', 'x-key': '$self', items: { type: 'string' } },
		},
	};

	it('add to set emits one add', () => {
		const e = new Engine<any>({ tags: ['urgent', 'review'] }, { schema });
		e.add('$.tags[0]', 'blocked');
		expect(e.diff()).toEqual([
			{ op: 'add', path: "$['tags'][0]", value: 'blocked', identity: 'blocked' },
		]);
	});

	it('remove from set emits one remove, not cascading replaces', () => {
		const e = new Engine<any>({ tags: ['urgent', 'review', 'blocked'] }, { schema });
		e.delete('$.tags[0]');
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['tags'][0]", value: 'urgent', identity: 'urgent' },
		]);
	});

	it('reorder is invisible under set semantics', () => {
		const e = new Engine<any>({ tags: ['a', 'b', 'c'] }, { schema });
		e.replace('$.tags', ['c', 'a', 'b']);
		expect(e.diff()).toEqual([]);
	});

	it('duplicates collapse under set semantics', () => {
		const e = new Engine<any>({ tags: ['urgent', 'urgent', 'review'] }, { schema });
		e.replace('$.tags', ['urgent', 'review']);
		expect(e.diff()).toEqual([]);
	});

	it('works on number sets', () => {
		const numericSchema = {
			type: 'object',
			properties: {
				ids: { type: 'array', 'x-key': '$self', items: { type: 'number' } },
			},
		};
		const e = new Engine<any>({ ids: [1, 2, 3] }, { schema: numericSchema });
		e.replace('$.ids', [2, 3, 4]);
		expect(e.diff()).toEqual([
			{ op: 'remove', path: "$['ids'][0]", value: 1, identity: 1 },
			{ op: 'add', path: "$['ids'][2]", value: 4, identity: 4 },
		]);
	});

	it('per-call $self override without schema', () => {
		const e = new Engine<any>({ tags: ['a', 'b'] });
		e.delete('$.tags[0]');
		expect(e.diff('$.tags', { key: '$self' })).toEqual([
			{ op: 'remove', path: "$['tags'][0]", value: 'a', identity: 'a' },
		]);
	});

	it('throws on object items — use x-key: <field> instead', () => {
		const e = new Engine<any>({ tags: [{ name: 'urgent' }, { name: 'review' }] }, { schema });
		e.replace('$.tags[0].name', 'blocked');
		expect(() => e.diff()).toThrow(/\$self.*requires primitive items/);
	});

	it('throws on nested-array items', () => {
		const e = new Engine<any>({ tags: [['a'], ['b']] }, { schema });
		e.replace('$.tags[0]', ['c']);
		expect(() => e.diff()).toThrow(/\$self.*requires primitive items/);
	});
});

describe('Engine.get with key', () => {
	it('marks unchanged items', () => {
		const e = new Engine<any>({ items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
		const result = e.get('$.items[*]', { key: 'id' });
		expect(result).toEqual([
			{ path: "$['items'][0]", value: { id: 1, name: 'a' }, identity: 1, op: 'unchanged' },
			{ path: "$['items'][1]", value: { id: 2, name: 'b' }, identity: 2, op: 'unchanged' },
		]);
	});

	it('marks added items (in draft, not in base)', () => {
		const e = new Engine<any>({ items: [{ id: 1, name: 'a' }] });
		e.add('$.items[1]', { id: 2, name: 'b' });
		const result = e.get('$.items[*]', { key: 'id' });
		expect(result.find(r => r.identity === 2)?.op).toBe('add');
		expect(result.find(r => r.identity === 1)?.op).toBe('unchanged');
	});

	it('appends removed items with path: null', () => {
		const e = new Engine<any>({ items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
		e.delete('$.items[0]');
		const result = e.get('$.items[*]', { key: 'id' });
		const removed = result.find(r => r.identity === 1);
		expect(removed).toEqual({ path: null, value: { id: 1, name: 'a' }, identity: 1, op: 'remove' });
		expect(result.find(r => r.identity === 2)?.op).toBe('unchanged');
	});

	it('marks modified items as replace', () => {
		const e = new Engine<any>({ items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
		e.replace('$.items[0].name', 'updated');
		const result = e.get('$.items[*]', { key: 'id' });
		expect(result.find(r => r.identity === 1)?.op).toBe('replace');
		expect(result.find(r => r.identity === 2)?.op).toBe('unchanged');
	});

	it('handles concurrent add + remove', () => {
		const e = new Engine<any>({ items: [{ id: 1 }, { id: 2 }] });
		e.delete('$.items[0]');
		e.add('$.items[1]', { id: 3 });
		const result = e.get('$.items[*]', { key: 'id' });
		expect(result.find(r => r.identity === 1)?.op).toBe('remove');
		expect(result.find(r => r.identity === 2)?.op).toBe('unchanged');
		expect(result.find(r => r.identity === 3)?.op).toBe('add');
	});

	it('draft items appear first, removed items appended at end', () => {
		const e = new Engine<any>({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
		e.delete('$.items[0]');
		const result = e.get('$.items[*]', { key: 'id' });
		const ops = result.map(r => r.op);
		expect(ops.indexOf('remove')).toBeGreaterThan(ops.lastIndexOf('unchanged'));
	});

	it('items missing the key field are included without identity', () => {
		const e = new Engine<any>({ items: [{ id: 1 }, { name: 'no-id' }] });
		const result = e.get('$.items[*]', { key: 'id' });
		const noId = result.find(r => r.identity === undefined);
		expect(noId).toBeDefined();
		expect(noId!.op).toBe('unchanged');
	});

	it('works with $self key for primitive arrays', () => {
		const e = new Engine<any>({ tags: ['a', 'b', 'c'] });
		e.delete('$.tags[0]');
		e.add('$.tags[2]', 'd');
		const result = e.get('$.tags[*]', { key: '$self' });
		expect(result.find(r => r.identity === 'a')?.op).toBe('remove');
		expect(result.find(r => r.identity === 'd')?.op).toBe('add');
		expect(result.find(r => r.identity === 'b')?.op).toBe('unchanged');
	});
});

describe('Engine.getBase with key', () => {
	it('returns base items annotated with their state relative to draft', () => {
		const e = new Engine<any>({ items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
		e.replace('$.items[0].name', 'updated');
		e.delete('$.items[1]');
		const result = e.getBase('$.items[*]', { key: 'id' });
		expect(result.find(r => r.identity === 1)?.op).toBe('replace');
		expect(result.find(r => r.identity === 2)?.op).toBe('remove');
	});

	it('does not include draft-only items (base-centric view)', () => {
		const e = new Engine<any>({ items: [{ id: 1 }] });
		e.add('$.items[1]', { id: 2 });
		const result = e.getBase('$.items[*]', { key: 'id' });
		expect(result.find(r => r.identity === 2)).toBeUndefined();
		expect(result.find(r => r.identity === 1)?.op).toBe('unchanged');
	});
});

describe('NodeEngine.get with key', () => {
	it('scopes the keyed get to the child subtree', () => {
		const e = new Engine<any>({ servers: [{ id: 'a' }, { id: 'b' }], other: [] });
		const child = e.getNodeEngine('$.servers');
		e.delete('$.servers[0]');
		const result = child.get('$[*]', { key: 'id' });
		expect(result.find(r => r.identity === 'a')?.op).toBe('remove');
		expect(result.find(r => r.identity === 'b')?.op).toBe('unchanged');
		// after deleting index 0, 'b' shifts to $[0] in draft
		expect(result.find(r => r.identity === 'b')?.path).toBe('$[0]');
	});
});
