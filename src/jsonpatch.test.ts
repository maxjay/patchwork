import { describe, it, expect } from 'vitest';
import { Engine } from './engine';
import { toJsonPatch, diffPatch, applyJsonPatch, jsonPathToPointer, JsonPatchError } from './jsonpatch';

describe('jsonPathToPointer', () => {
	it('converts a normalized JSONPath to a JSON Pointer', () => {
		expect(jsonPathToPointer("$['a']['b'][0]")).toBe('/a/b/0');
	});

	it('maps the root path to the empty pointer', () => {
		expect(jsonPathToPointer('$')).toBe('');
	});

	it('escapes ~ and / in keys per RFC 6901', () => {
		expect(jsonPathToPointer("$['a~b']")).toBe('/a~0b');
		expect(jsonPathToPointer("$['a/b']")).toBe('/a~1b');
	});
});

describe('toJsonPatch / diffPatch', () => {
	it('converts add/replace/remove into JSON-Pointer-addressed ops', () => {
		const e = new Engine({ server: { host: 'localhost', port: 8080 }, debug: false });
		e.replace('$.server.port', 443);
		e.add('$.server.ssl', true);
		e.delete('$.debug');

		const patch = diffPatch(e);
		expect(patch).toEqual(
			expect.arrayContaining([
				{ op: 'replace', path: '/server/port', value: 443 },
				{ op: 'add', path: '/server/ssl', value: true },
				{ op: 'remove', path: '/debug' },
			]),
		);
		expect(patch).toHaveLength(3);
	});

	it('produces a patch applyJsonPatch can replay onto base to reach draft', () => {
		const e = new Engine({ a: 1, b: { c: 2 }, items: [1, 2, 3] });
		e.replace('$.b.c', 99);
		e.add('$.items[1]', 'X');
		e.delete('$.a');

		const patch = diffPatch(e);
		expect(applyJsonPatch(e.base, patch)).toEqual(e.draft);
	});

	it('drops unchanged ops', () => {
		const e = new Engine({ a: 1 });
		const patch = toJsonPatch(e.diff(undefined, { includeUnchanged: true } as any));
		expect(patch).toEqual([]);
	});

	it('converts move/copy ops (as recorded on the undo stack) using from/path', () => {
		const e = new Engine({ a: 1 });
		e.copy('$.a', '$.b');
		const patch = toJsonPatch(e.exportChanges());
		expect(patch).toEqual([{ op: 'copy', from: '/a', path: '/b' }]);
	});

	it('converts a displacement move from an ordered identity-keyed array', () => {
		const e = new Engine(
			{ steps: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: { type: 'object', properties: { steps: { type: 'array', 'x-key': 'id', 'x-ordered': true, items: { type: 'object' } } } } },
		);
		e.delete('$.steps[0]');
		const patch = diffPatch(e, '$.steps');
		expect(patch).toEqual(expect.arrayContaining([
			{ op: 'remove', path: '/steps/0' },
			{ op: 'move', from: '/steps/1', path: '/steps/0' },
			{ op: 'move', from: '/steps/2', path: '/steps/1' },
		]));
	});

	it('flattens identity-keyed element replace into field-level ops', () => {
		const e = new Engine(
			{ regions: [{ id: 'us-east', capacity: 100 }] },
			{ schema: { type: 'object', properties: { regions: { type: 'array', 'x-key': 'id', items: { type: 'object' } } } } },
		);
		e.replace('$.regions[0].capacity', 90);
		const patch = diffPatch(e, '$.regions');
		expect(patch).toEqual([{ op: 'replace', path: '/regions/0/capacity', value: 90 }]);
	});

	it('throws for revert ops (no RFC 6902 equivalent)', () => {
		const e = new Engine({ a: 1 });
		e.replace('$.a', 2);
		e.revert('$.a');
		expect(() => toJsonPatch(e.exportChanges())).toThrow(/revert/);
	});
});

describe('applyJsonPatch — RFC 6902 §4 operations', () => {
	it('add: adds an object member', () => {
		const doc = { a: { foo: 1 } };
		const result = applyJsonPatch(doc, [{ op: 'add', path: '/a/b', value: 'foo' }]);
		expect(result).toEqual({ a: { foo: 1, b: 'foo' } });
		expect(doc).toEqual({ a: { foo: 1 } }); // input untouched
	});

	it('add: inserts an array element, shifting the rest', () => {
		const doc = { a: { foo: ['bar', 'baz'] } };
		const result = applyJsonPatch(doc, [{ op: 'add', path: '/a/foo/1', value: 'qux' }]);
		expect(result).toEqual({ a: { foo: ['bar', 'qux', 'baz'] } });
	});

	it('add: "-" appends to the end of an array', () => {
		const result = applyJsonPatch({ items: [1, 2] }, [{ op: 'add', path: '/items/-', value: 3 }]);
		expect(result).toEqual({ items: [1, 2, 3] });
	});

	it('add: replaces the whole document at the root pointer', () => {
		const result = applyJsonPatch({ a: 1 }, [{ op: 'add', path: '', value: { b: 2 } }]);
		expect(result).toEqual({ b: 2 });
	});

	it('add: errors when the parent does not exist', () => {
		expect(() => applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/x/y', value: 1 }]))
			.toThrow(JsonPatchError);
	});

	it('remove: removes an object member', () => {
		const result = applyJsonPatch({ a: { foo: 1, bar: 2 } }, [{ op: 'remove', path: '/a/bar' }]);
		expect(result).toEqual({ a: { foo: 1 } });
	});

	it('remove: removes an array element, shifting the rest', () => {
		const result = applyJsonPatch({ a: [1, 2, 3, 4] }, [{ op: 'remove', path: '/a/1' }]);
		expect(result).toEqual({ a: [1, 3, 4] });
	});

	it('remove: errors on a missing member', () => {
		expect(() => applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/b' }])).toThrow(JsonPatchError);
	});

	it('replace: replaces an object member', () => {
		const result = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'replace', path: '/a', value: 99 }]);
		expect(result).toEqual({ a: 99, b: 2 });
	});

	it('replace: replaces an array element in place (no shift)', () => {
		const result = applyJsonPatch({ a: [1, 2, 3] }, [{ op: 'replace', path: '/a/1', value: 99 }]);
		expect(result).toEqual({ a: [1, 99, 3] });
	});

	it('replace: errors when the target does not already exist', () => {
		expect(() => applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 1 }])).toThrow(JsonPatchError);
	});

	it('move: moves a member between objects', () => {
		const result = applyJsonPatch({ a: { foo: 1 }, b: {} }, [{ op: 'move', from: '/a/foo', path: '/b/foo' }]);
		expect(result).toEqual({ a: {}, b: { foo: 1 } });
	});

	it('move: within an array, resolves the target after the source is removed', () => {
		// RFC 6902 example: move /foo/1 ("b") to /foo/3 in ["a","b","c","d"]
		const result = applyJsonPatch({ foo: ['a', 'b', 'c', 'd'] }, [{ op: 'move', from: '/foo/1', path: '/foo/3' }]);
		expect(result).toEqual({ foo: ['a', 'c', 'd', 'b'] });
	});

	it('move: errors when moving a location into its own child', () => {
		expect(() => applyJsonPatch({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/b' }]))
			.toThrow(JsonPatchError);
	});

	it('move: from == path is a validated no-op', () => {
		const result = applyJsonPatch({ a: 1 }, [{ op: 'move', from: '/a', path: '/a' }]);
		expect(result).toEqual({ a: 1 });
	});

	it('copy: duplicates a value without removing the source', () => {
		const result = applyJsonPatch({ a: { foo: 1 }, b: {} }, [{ op: 'copy', from: '/a/foo', path: '/b/foo' }]);
		expect(result).toEqual({ a: { foo: 1 }, b: { foo: 1 } });
	});

	it('copy: is a deep copy, not a shared reference', () => {
		const result = applyJsonPatch({ a: { foo: { n: 1 } } }, [
			{ op: 'copy', from: '/a/foo', path: '/a/bar' },
			{ op: 'replace', path: '/a/bar/n', value: 2 },
		]) as any;
		expect(result.a.foo).toEqual({ n: 1 });
		expect(result.a.bar).toEqual({ n: 2 });
	});

	it('test: succeeds silently when the value matches', () => {
		const result = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'test', path: '/a', value: 1 }, { op: 'replace', path: '/b', value: 3 }]);
		expect(result).toEqual({ a: 1, b: 3 });
	});

	it('test: deep-equal, not reference-equal, for objects and arrays', () => {
		const result = applyJsonPatch({ a: { x: 1, y: [1, 2] } }, [{ op: 'test', path: '/a', value: { x: 1, y: [1, 2] } }]);
		expect(result).toEqual({ a: { x: 1, y: [1, 2] } });
	});

	it('test: fails the whole patch atomically when the value does not match', () => {
		const doc = { a: 1, b: 2 };
		expect(() => applyJsonPatch(doc, [
			{ op: 'replace', path: '/b', value: 99 },
			{ op: 'test', path: '/a', value: 'not-1' },
		])).toThrow(JsonPatchError);
		expect(doc).toEqual({ a: 1, b: 2 }); // untouched — atomic failure
	});
});

describe('applyJsonPatch — atomicity and error reporting', () => {
	it('applies no partial changes when a later op fails', () => {
		const doc = { a: 1 };
		expect(() => applyJsonPatch(doc, [
			{ op: 'add', path: '/b', value: 2 },
			{ op: 'remove', path: '/does-not-exist' },
		])).toThrow(JsonPatchError);
		expect(doc).toEqual({ a: 1 });
	});

	it('reports the failing operation index and the operation itself', () => {
		try {
			applyJsonPatch({ a: 1 }, [
				{ op: 'replace', path: '/a', value: 2 },
				{ op: 'remove', path: '/missing' },
			]);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(JsonPatchError);
			const err = e as JsonPatchError;
			expect(err.index).toBe(1);
			expect(err.operation).toEqual({ op: 'remove', path: '/missing' });
		}
	});

	it('rejects a malformed pointer', () => {
		expect(() => applyJsonPatch({ a: 1 }, [{ op: 'add', path: 'a', value: 1 } as any])).toThrow(JsonPatchError);
	});

	it('rejects an out-of-range array index', () => {
		expect(() => applyJsonPatch({ a: [1, 2] }, [{ op: 'add', path: '/a/5', value: 1 }])).toThrow(JsonPatchError);
	});

	it('rejects a leading-zero array index', () => {
		expect(() => applyJsonPatch({ a: [1, 2] }, [{ op: 'replace', path: '/a/01', value: 1 }])).toThrow(JsonPatchError);
	});

	it('rejects an operation missing a required field', () => {
		expect(() => applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b' } as any])).toThrow(JsonPatchError);
	});

	it('handles ~0 / ~1 escaping in pointer tokens', () => {
		const result = applyJsonPatch({}, [{ op: 'add', path: '/a~1b', value: 1 }, { op: 'add', path: '/a~0b', value: 2 }]);
		expect(result).toEqual({ 'a/b': 1, 'a~b': 2 });
	});
});

describe('round-trip: Engine.diff -> toJsonPatch -> applyJsonPatch', () => {
	it('reproduces draft from base for a mix of add/replace/remove/move', () => {
		const e = new Engine({
			user: { name: 'Ada', age: 30, tags: ['admin'] },
			legacy: true,
		});
		e.replace('$.user.age', 31);
		e.add('$.user.tags[1]', 'owner');
		e.delete('$.legacy');
		e.move('$.user.name', '$.user.fullName');

		const patch = diffPatch(e);
		expect(applyJsonPatch(e.base, patch)).toEqual(e.draft);
	});
});
