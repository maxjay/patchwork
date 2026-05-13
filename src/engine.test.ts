import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from './engine';

describe('Engine.replace', () => {
	it('replaces a value in an object', () => {
		const e = new Engine({ a: { b: 3 } });
		e.replace('$.a.b', 99);
		expect(e.base).toEqual({ a: { b: 99 } });
		e.undo();
		expect(e.base).toEqual({ a: { b: 3 } });
		e.redo();
		expect(e.base).toEqual({ a: { b: 99 } });
	});

	it('replaces an element in an array', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.replace('$.items[1]', 'X');
		expect(e.base).toEqual({ items: ['a', 'X', 'c'] });
		e.undo();
		expect(e.base).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.base).toEqual({ items: ['a', 'X', 'c'] });
	});

	it('replaces all matching elements with a wildcard', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.replace('$.items[*]', 0);
		expect(e.base).toEqual({ items: [0, 0, 0] });
		e.undo();
		expect(e.base).toEqual({ items: [1, 2, 3] });
		e.redo();
		expect(e.base).toEqual({ items: [0, 0, 0] });
	});
});

describe('Engine.add', () => {
	it('sets a new key on an object', () => {
		const e = new Engine<any>({ a: 1 });
		e.add('$.b', 2);
		expect(e.base).toEqual({ a: 1, b: 2 });
	});

	it('overwrites an existing object key', () => {
		const e = new Engine({ a: 1 });
		e.add('$.a', 99);
		expect(e.base).toEqual({ a: 99 });
	});

	it('inserts into an array without removing the existing element', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.add('$.items[1]', 'X');
		expect(e.base).toEqual({ items: ['a', 'X', 'b', 'c'] });
	});

	it('inserts at index 0, shifting all elements right', () => {
		const e = new Engine({ items: ['a', 'b'] });
		e.add('$.items[0]', 'X');
		expect(e.base).toEqual({ items: ['X', 'a', 'b'] });
	});

	it('inserts at multiple array positions without corrupting indices', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		// Wildcard matches [0,1,2]; reversing before insert keeps indices stable
		e.add('$.items[*]', 'X');
		expect(e.base).toEqual({ items: ['X', 'a', 'X', 'b', 'X', 'c'] });
	});
});

describe('Engine.add (creates missing intermediates)', () => {
	it('creates a missing nested object key', () => {
		const e = new Engine<any>({});
		e.add('$.a.b', 1);
		expect(e.base).toEqual({ a: { b: 1 } });
		e.undo();
		expect(e.base).toEqual({});
		e.redo();
		expect(e.base).toEqual({ a: { b: 1 } });
	});

	it('creates several missing intermediates in one shot', () => {
		const e = new Engine<any>({});
		e.add('$.a.b.c.d', 5);
		expect(e.base).toEqual({ a: { b: { c: { d: 5 } } } });
		e.undo();
		expect(e.base).toEqual({});
	});

	it('creates an array when the next segment is an index', () => {
		const e = new Engine<any>({});
		e.add('$.a[0].b', 1);
		expect(e.base).toEqual({ a: [{ b: 1 }] });
		e.undo();
		expect(e.base).toEqual({});
	});

	it('mixes existing prefix with fabricated tail', () => {
		const e = new Engine<any>({ a: { b: 3 } });
		e.add('$.a.b.c[0].d', 5);
		expect(e.base).toEqual({ a: { b: { c: [{ d: 5 }] } } });
	});

	it('undo restores at the divergence point, not the leaf', () => {
		// `b` is a scalar that gets overwritten with an object to make room for c.
		// Undo must put `b` back to 3, not try to surgically remove `c`.
		const e = new Engine<any>({ a: { b: 3 } });
		e.add('$.a.b.c', 5);
		expect(e.base).toEqual({ a: { b: { c: 5 } } });
		e.undo();
		expect(e.base).toEqual({ a: { b: 3 } });
		e.redo();
		expect(e.base).toEqual({ a: { b: { c: 5 } } });
	});

	it('undo removes the top-level key when the whole prefix was fabricated', () => {
		const e = new Engine<any>({ x: 1 });
		e.add('$.a.b.c', 5);
		expect(e.base).toEqual({ x: 1, a: { b: { c: 5 } } });
		e.undo();
		expect(e.base).toEqual({ x: 1 });
	});

	it('throws when a non-resolving path contains a wildcard', () => {
		const e = new Engine<any>({});
		expect(() => e.add('$.a.*', 1)).toThrow();
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
		expect(e.base).toEqual({ b: 2 });
		e.undo();
		expect(e.base).toEqual({ a: 1, b: 2 });
		e.redo();
		expect(e.base).toEqual({ b: 2 });
	});

	it('removes an element from an array', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[1]');
		expect(e.base).toEqual({ items: ['a', 'c'] });
		e.undo();
		expect(e.base).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.base).toEqual({ items: ['a', 'c'] });
	});

	it('removes multiple array elements without index corruption', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[*]');
		expect(e.base).toEqual({ items: [] });
		e.undo();
		expect(e.base).toEqual({ items: ['a', 'b', 'c'] });
		e.redo();
		expect(e.base).toEqual({ items: [] });
	});

	it('removes a nested key', () => {
		const e = new Engine<any>({ a: { b: 1, c: 2 } });
		e.delete('$.a.b');
		expect(e.base).toEqual({ a: { c: 2 } });
		e.undo();
		expect(e.base).toEqual({ a: { b: 1, c: 2 } });
		e.redo();
		expect(e.base).toEqual({ a: { c: 2 } });
	});

	it('does nothing when the path matches nothing', () => {
		const e = new Engine({ a: 1 });
		e.delete('$.z');
		expect(e.base).toEqual({ a: 1 });
		e.undo();
		// State shouldn't change if nothing was deleted
		expect(e.base).toEqual({ a: 1 });
		e.redo();
		expect(e.base).toEqual({ a: 1 });
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
		expect(e.base).toEqual({ a: 99 });
		e.revert('$.a');
		expect(e.base).toEqual({ a: 1 });
		e.undo(); // Undo the revert!
		expect(e.base).toEqual({ a: 99 });
	});

	it('reverts an added value by deleting it', () => {
		const e = new Engine<any>({ a: 1 });
		e.add('$.b', 2);
		expect(e.base).toEqual({ a: 1, b: 2 });
		e.revert('$.b');
		expect(e.base).toEqual({ a: 1 });
	});

	it('reverts a deleted value by restoring it', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.b');
		expect(e.base).toEqual({ a: 1 });
		e.revert('$.b');
		expect(e.base).toEqual({ a: 1, b: 2 });
	});

	it('handles wildcard reverts', () => {
		const e = new Engine({ items: [1, 2, 3] });
		e.replace('$.items[*]', 0);
		expect(e.base).toEqual({ items: [0, 0, 0] });
		e.revert('$.items[*]');
		expect(e.base).toEqual({ items: [1, 2, 3] });
	});
});

describe('Engine.move', () => {
	it('moves a value from one path to another', () => {
		const e = new Engine<any>({ a: { b: 3 }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: 3 });

		e.undo();
		expect(e.base).toEqual({ a: { b: 3 }, x: 0 });
	});

	it('moves an object from one path to another', () => {
		const e = new Engine<any>({ a: { b: { foo: 'bar' } }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: { foo: 'bar' } });

		e.undo();
		expect(e.base).toEqual({ a: { b: { foo: 'bar' } }, x: 0 });
	});

	it('moves an array element from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b[1]', '$.x');
		expect(e.base).toEqual({ a: { b: [3, 5] }, x: 4 });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves an array from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: [3, 4, 5] });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves item to end of an array', () => {
		const e = new Engine<any>({ a: { b: 6 }, x: [3, 4, 5] });
		e.move('$.a.b', '$.x[3]');
		expect(e.base).toEqual({ a: {}, x: [3, 4, 5, 6] });

		e.undo();
		expect(e.base).toEqual({ a: { b: 6 }, x: [3, 4, 5] });
	});

	it('throws when from path resolves to more than one path', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		expect(() => e.move('$.items[*].id', '$.value')).toThrow('Move source must resolve to exactly one path');
	});

	it('moves one source value into multiple normalized target paths', () => {
		const e = new Engine({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
		e.move('$.a.b', '$.items[*].x');
		expect(e.base).toEqual({ a: {}, items: [{ x: 1 }, { x: 1 }] });
	});
});

describe('Engine.move', () => {
	it('moves a value from one path to another', () => {
		const e = new Engine<any>({ a: { b: 3 }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: 3 });

		e.undo();
		expect(e.base).toEqual({ a: { b: 3 }, x: 0 });
	});

	it('moves an object from one path to another', () => {
		const e = new Engine<any>({ a: { b: { foo: 'bar' } }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: { foo: 'bar' } });

		e.undo();
		expect(e.base).toEqual({ a: { b: { foo: 'bar' } }, x: 0 });
	});

	it('moves an array element from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b[1]', '$.x');
		expect(e.base).toEqual({ a: { b: [3, 5] }, x: 4 });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves an array from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.move('$.a.b', '$.x');
		expect(e.base).toEqual({ a: {}, x: [3, 4, 5] });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('moves item to end of an array', () => {
		const e = new Engine<any>({ a: { b: 6 }, x: [3, 4, 5] });
		e.move('$.a.b', '$.x[3]');
		expect(e.base).toEqual({ a: {}, x: [3, 4, 5, 6] });

		e.undo();
		expect(e.base).toEqual({ a: { b: 6 }, x: [3, 4, 5] });
	});

	it('moves one source value into multiple normalized target paths', () => {
		const e = new Engine({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
		e.move('$.a.b', '$.items[*].x');
		expect(e.base).toEqual({ a: {}, items: [{ x: 1 }, { x: 1 }] });

		e.undo();
		expect(e.base).toEqual({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
	});

	it('throws when from path resolves to more than one path', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		expect(() => e.move('$.items[*].id', '$.value')).toThrow('Move source must resolve to exactly one path');
	});

	it('throws when moving a path into one of its own descendants', () => {
		const e = new Engine({ a: { b: { c: 1 } } } );
		expect(() => e.move('$.a.b', '$.a.b.c.d')).toThrow('Invalid move target: cannot move a path into one of its own descendants');
	});
});

describe('Engine.copy', () => {
	it('copies a value from one path to another', () => {
		const e = new Engine<any>({ a: { b: 3 }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.base).toEqual({ a: { b: 3 }, x: 3 });

		e.undo();
		expect(e.base).toEqual({ a: { b: 3 }, x: 0 });
	});

	it('copies an object from one path to another', () => {
		const e = new Engine<any>({ a: { b: { foo: 'bar' } }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.base).toEqual({ a: { b: { foo: 'bar' } }, x: { foo: 'bar' } });

		e.undo();
		expect(e.base).toEqual({ a: { b: { foo: 'bar' } }, x: 0 });
	});

	it('copies an array element from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.copy('$.a.b[1]', '$.x');
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 4 });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('copies an array from one path to another', () => {
		const e = new Engine<any>({ a: { b: [3, 4, 5] }, x: 0 });
		e.copy('$.a.b', '$.x');
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: [3, 4, 5] });

		e.undo();
		expect(e.base).toEqual({ a: { b: [3, 4, 5] }, x: 0 });
	});

	it('copies item to end of an array', () => {
		const e = new Engine<any>({ a: { b: 6 }, x: [3, 4, 5] });
		e.copy('$.a.b', '$.x[3]');
		expect(e.base).toEqual({ a: { b: 6 }, x: [3, 4, 5, 6] });

		e.undo();
		expect(e.base).toEqual({ a: { b: 6 }, x: [3, 4, 5] });
	});

	it('copies one source value into multiple normalized target paths', () => {
		const e = new Engine({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
		e.copy('$.a.b', '$.items[*].x');
		expect(e.base).toEqual({ a: { b: 1 }, items: [{ x: 1 }, { x: 1 }] });

		e.undo();
		expect(e.base).toEqual({ a: { b: 1 }, items: [{ x: 0 }, { x: 0 }] });
	});

	it('throws when from path resolves to more than one path', () => {
		const e = new Engine({ items: [{ id: 1 }, { id: 2 }] });
		expect(() => e.copy('$.items[*].id', '$.value')).toThrow('Copy source must resolve to exactly one path');
	});

	it('allows copying a path into one of its own descendants', () => {
		const e = new Engine({ a: { b: { c: 1 } } } );
		e.copy('$.a.b', '$.a.b.x');
		expect(e.base).toEqual({ a: { b: { c: 1, x: { c: 1 } } } } );
		
		e.undo();
		expect(e.base).toEqual({ a: { b: { c: 1 } } } );
	});
});

