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

describe('Engine.delete', () => {
	it('removes a key from an object', () => {
		const e = new Engine<any>({ a: 1, b: 2 });
		e.delete('$.a');
		expect(e.base).toEqual({ b: 2 });
	});

	it('removes an element from an array', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[1]');
		expect(e.base).toEqual({ items: ['a', 'c'] });
	});

	it('removes multiple array elements without index corruption', () => {
		const e = new Engine({ items: ['a', 'b', 'c'] });
		e.delete('$.items[*]');
		expect(e.base).toEqual({ items: [] });
	});

	it('removes a nested key', () => {
		const e = new Engine<any>({ a: { b: 1, c: 2 } });
		e.delete('$.a.b');
		expect(e.base).toEqual({ a: { c: 2 } });
	});

	it('does nothing when the path matches nothing', () => {
		const e = new Engine({ a: 1 });
		e.delete('$.z');
		expect(e.base).toEqual({ a: 1 });
	});
});
