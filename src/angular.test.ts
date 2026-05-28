import { describe, it, expect } from 'vitest';
import { computed } from '@angular/core';
import { Engine } from './engine.js';
import { createPatchworkStore, fromEngine } from './angular.js';

describe('createPatchworkStore', () => {
	it('exposes draft and base as signals starting equal', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		expect(store.draft()).toEqual({ x: 1 });
		expect(store.base()).toEqual({ x: 1 });
	});

	it('draft signal updates after replace; base stays', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		store.replace('$.x', 2);
		expect(store.draft()).toEqual({ x: 2 });
		expect(store.base()).toEqual({ x: 1 });
	});

	it('base signal updates after accept', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		store.replace('$.x', 2);
		store.accept();
		expect(store.base()).toEqual({ x: 2 });
	});

	it('decline resets draft signal', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		store.replace('$.x', 99);
		store.decline();
		expect(store.draft()).toEqual({ x: 1 });
	});

	it('undo reverses last mutation and reflects in signals', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		store.replace('$.x', 2);
		store.undo();
		expect(store.draft()).toEqual({ x: 1 });
	});

	it('redo replays last undone mutation', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		store.replace('$.x', 2);
		store.undo();
		store.redo();
		expect(store.draft()).toEqual({ x: 2 });
	});
});

describe('PatchworkStore reactive reads', () => {
	it('get() returns a Signal that updates on mutation', () => {
		const store = createPatchworkStore<any>({ items: ['a', 'b'] });
		const items = store.get('$.items[*]');
		expect(items().map(r => r.value)).toEqual(['a', 'b']);
		store.add('$.items[2]', 'c');
		expect(items().map(r => r.value)).toEqual(['a', 'b', 'c']);
	});

	it('getValue() returns a Signal scoped to a single path', () => {
		const store = createPatchworkStore<any>({ port: 8080 });
		const port = store.getValue('$.port');
		expect(port()).toBe(8080);
		store.replace('$.port', 443);
		expect(port()).toBe(443);
	});

	it('getBase() reflects base, not draft', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		const baseX = store.getBase('$.x');
		store.replace('$.x', 99);
		expect(baseX().map(r => r.value)).toEqual([1]);
		expect(store.get('$.x')().map(r => r.value)).toEqual([99]);
	});

	it('getValueBase() reflects base, updates after accept', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		const baseX = store.getValueBase('$.x');
		store.replace('$.x', 99);
		expect(baseX()).toBe(1);
		store.accept();
		expect(baseX()).toBe(99);
	});

	it('diff() returns a Signal of current diff ops', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		const diff = store.diff();
		expect(diff()).toEqual([]);
		store.replace('$.x', 2);
		expect(diff()).toEqual([
			{ op: 'replace', path: "$['x']", oldValue: 1, value: 2 },
		]);
	});

	it('diff(path) scopes to a subtree', () => {
		const store = createPatchworkStore<any>({ a: { x: 1 }, b: { y: 1 } });
		const aDiff = store.diff('$.a');
		store.replace('$.a.x', 2);
		store.replace('$.b.y', 2);
		expect(aDiff()).toHaveLength(1);
		expect(aDiff()[0].path).toBe("$['a']['x']");
	});

	it('diff(path, { key }) enables identity diff at call time', () => {
		const store = createPatchworkStore<any>({ items: [{ id: 1 }, { id: 2 }] });
		const itemsDiff = store.diff('$.items', { key: 'id' });
		store.delete('$.items[0]');
		expect(itemsDiff()).toEqual([
			{ op: 'remove', path: "$['items'][0]", value: { id: 1 }, identity: 1 },
		]);
	});

	it('diff signal becomes empty after accept', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		const diff = store.diff();
		store.replace('$.x', 2);
		expect(diff()).toHaveLength(1);
		store.accept();
		expect(diff()).toEqual([]);
	});
});

describe('PatchworkStore computed integration', () => {
	it('a downstream computed re-evaluates when draft changes', () => {
		const store = createPatchworkStore<any>({ count: 1 });
		const doubled = computed(() => store.draft().count * 2);
		expect(doubled()).toBe(2);
		store.replace('$.count', 5);
		expect(doubled()).toBe(10);
	});

	it('a downstream computed reading diff re-evaluates after mutations', () => {
		const store = createPatchworkStore<any>({ x: 1 });
		const diff = store.diff();
		const summary = computed(() => `${diff().length} changes`);
		expect(summary()).toBe('0 changes');
		store.replace('$.x', 2);
		expect(summary()).toBe('1 changes');
	});
});

describe('PatchworkStore.scope', () => {
	it('creates a sub-store rooted at a subtree', () => {
		const store = createPatchworkStore<any>({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'green' }],
		});
		const cars = store.scope<any>('$.cars');
		expect(cars.draft()).toEqual([{ color: 'red' }]);
	});

	it('mutations through child are visible in parent draft signal', () => {
		const store = createPatchworkStore<any>({ cars: [{ color: 'red' }] });
		const cars = store.scope<any>('$.cars');
		cars.replace('$[0].color', 'yellow');
		expect(store.draft().cars[0].color).toBe('yellow');
		expect(cars.draft()[0].color).toBe('yellow');
	});

	it('mutations through parent are visible in child draft signal', () => {
		const store = createPatchworkStore<any>({ cars: [{ color: 'red' }] });
		const cars = store.scope<any>('$.cars');
		store.replace('$.cars[0].color', 'blue');
		expect(cars.draft()[0].color).toBe('blue');
	});

	it('child accept() commits subtree to parent base', () => {
		const store = createPatchworkStore<any>({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'green' }],
		});
		const cars = store.scope<any>('$.cars');
		store.replace('$.cars[0].color', 'yellow');
		store.replace('$.trucks[0].color', 'purple');
		cars.accept();
		expect(store.base().cars[0].color).toBe('yellow');
		expect(store.base().trucks[0].color).toBe('green'); // unchanged
	});

	it('child diff() is scoped to its subtree', () => {
		const store = createPatchworkStore<any>({
			cars: [{ color: 'red' }],
			trucks: [{ color: 'green' }],
		});
		const cars = store.scope<any>('$.cars');
		const carsDiff = cars.diff();
		store.replace('$.cars[0].color', 'yellow');
		store.replace('$.trucks[0].color', 'purple');
		expect(carsDiff()).toHaveLength(1);
	});

	it('beginEphemeral throws on scoped stores', () => {
		const store = createPatchworkStore<any>({ x: { y: 1 } });
		const child = store.scope<any>('$.x');
		expect(() => child.beginEphemeral()).toThrow(/not available on scoped stores/);
	});
});

describe('PatchworkStore ephemeral', () => {
	it('beginEphemeral + commitEphemeral collapses to one undo entry', () => {
		const store = createPatchworkStore<any>({ x: 0 });
		store.beginEphemeral();
		store.replace('$.x', 1);
		store.replace('$.x', 2);
		store.replace('$.x', 3);
		store.commitEphemeral();
		expect(store.draft().x).toBe(3);
		store.undo();
		expect(store.draft().x).toBe(0);
	});

	it('discardEphemeral unwinds session changes', () => {
		const store = createPatchworkStore<any>({ x: 0 });
		store.beginEphemeral();
		store.replace('$.x', 1);
		store.replace('$.x', 2);
		store.discardEphemeral();
		expect(store.draft().x).toBe(0);
	});
});

describe('fromEngine', () => {
	it('wraps an existing engine', () => {
		const engine = new Engine<any>({ x: 1 });
		const store = fromEngine(engine);
		expect(store.draft()).toEqual({ x: 1 });
		expect(store.engine).toBe(engine);
	});

	it('mutations through wrapped store fire signals', () => {
		const engine = new Engine<any>({ x: 1 });
		const store = fromEngine(engine);
		store.replace('$.x', 2);
		expect(store.draft()).toEqual({ x: 2 });
	});

	it('direct engine mutations are not reflected (use the store)', () => {
		// Documents the contract: changes have to go through the store to fire signals.
		// Mutating the engine directly bypasses the tick.
		const engine = new Engine<any>({ x: 1 });
		const store = fromEngine(engine);
		const draftBefore = store.draft();
		engine.replace('$.x', 2);
		// Reading draft() again — the signal hasn't fired, so the computed returns
		// the cached value from the last tick. (Engine state did change, but the
		// reactive layer doesn't know that.)
		expect(store.draft()).toBe(draftBefore);
	});
});
