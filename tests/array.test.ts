import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('ARRAY — Keyed array operations', () => {
  // ─── Basic array ops ──────────────────────────────────────────────────────

  it('append to array with /-', () => {
    const engine = new Engine({ items: [1, 2, 3] });
    engine.propose({ kind: 'add', path: '/items/-', value: 4 });
    expect(engine.get('/items')).toEqual([1, 2, 3, 4]);
    expect(engine.export()).toEqual({ items: [1, 2, 3, 4] });
  });

  it('replace array element by index', () => {
    const engine = new Engine({ items: ['a', 'b', 'c'] });
    engine.propose({ kind: 'replace', path: '/items/1', value: 'B' });
    expect(engine.get('/items/1')).toBe('B');
    expect(engine.export()).toEqual({ items: ['a', 'B', 'c'] });
  });

  it('remove array element by index', () => {
    const engine = new Engine({ items: [10, 20, 30] });
    engine.propose({ kind: 'remove', path: '/items/1' });
    expect(engine.export()).toEqual({ items: [10, 30] });
  });

  it('get array element by index', () => {
    const engine = new Engine({ items: ['x', 'y', 'z'] });
    expect(engine.get('/items/0')).toBe('x');
    expect(engine.get('/items/2')).toBe('z');
  });

  it('get entire array', () => {
    const engine = new Engine({ items: [1, 2] });
    expect(engine.get('/items')).toEqual([1, 2]);
  });

  // ─── Index stability (the core problem keyed arrays solve) ────────────────

  it('remove and replace on same array target correct elements', () => {
    const engine = new Engine({ items: ['a', 'b', 'c', 'd'] });

    // Remove 'b' (index 1)
    engine.propose({ kind: 'remove', path: '/items/1' });
    // Now the array looks like ['a', 'c', 'd']
    // Replace 'c' (now at index 1, was at index 2)
    engine.propose({ kind: 'replace', path: '/items/1', value: 'C' });

    expect(engine.export()).toEqual({ items: ['a', 'C', 'd'] });
  });

  it('two appends produce two elements', () => {
    const engine = new Engine({ items: [1] });
    engine.propose({ kind: 'add', path: '/items/-', value: 2 });
    engine.propose({ kind: 'add', path: '/items/-', value: 3 });
    expect(engine.export()).toEqual({ items: [1, 2, 3] });
  });

  it('remove then append', () => {
    const engine = new Engine({ items: ['a', 'b', 'c'] });
    engine.propose({ kind: 'remove', path: '/items/0' });
    engine.propose({ kind: 'add', path: '/items/-', value: 'd' });
    expect(engine.export()).toEqual({ items: ['b', 'c', 'd'] });
  });

  // ─── Undo / redo with arrays ──────────────────────────────────────────────

  it('undo append restores original array', () => {
    const engine = new Engine({ items: [1, 2] });
    engine.propose({ kind: 'add', path: '/items/-', value: 3 });
    expect(engine.export()).toEqual({ items: [1, 2, 3] });

    engine.undo();
    expect(engine.export()).toEqual({ items: [1, 2] });
  });

  it('undo remove restores the element', () => {
    const engine = new Engine({ items: ['a', 'b', 'c'] });
    engine.propose({ kind: 'remove', path: '/items/1' });
    expect(engine.export()).toEqual({ items: ['a', 'c'] });

    engine.undo();
    expect(engine.export()).toEqual({ items: ['a', 'b', 'c'] });
  });

  it('undo replace restores previous value', () => {
    const engine = new Engine({ items: [10, 20, 30] });
    engine.propose({ kind: 'replace', path: '/items/2', value: 99 });
    engine.undo();
    expect(engine.export()).toEqual({ items: [10, 20, 30] });
  });

  it('redo after undo of array op', () => {
    const engine = new Engine({ items: [1] });
    engine.propose({ kind: 'add', path: '/items/-', value: 2 });
    engine.undo();
    engine.redo();
    expect(engine.export()).toEqual({ items: [1, 2] });
  });

  // ─── Nested arrays / array of objects ─────────────────────────────────────

  it('edit a field inside an array element', () => {
    const engine = new Engine({ users: [{ name: 'Alice' }, { name: 'Bob' }] });
    engine.propose({ kind: 'replace', path: '/users/1/name', value: 'Bobby' });
    expect(engine.get('/users/1/name')).toBe('Bobby');
    expect(engine.export()).toEqual({ users: [{ name: 'Alice' }, { name: 'Bobby' }] });
  });

  it('add a field to an array element', () => {
    const engine = new Engine({ users: [{ name: 'Alice' }] });
    engine.propose({ kind: 'add', path: '/users/0/email', value: 'alice@example.com' });
    expect(engine.export()).toEqual({ users: [{ name: 'Alice', email: 'alice@example.com' }] });
  });

  it('remove then edit different element targets correctly', () => {
    const engine = new Engine({
      users: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
    });
    // Remove Alice (index 0)
    engine.propose({ kind: 'remove', path: '/users/0' });
    // Edit Bob (now at index 0, was at index 1)
    engine.propose({ kind: 'replace', path: '/users/0/name', value: 'Robert' });
    expect(engine.export()).toEqual({
      users: [{ name: 'Robert' }, { name: 'Carol' }],
    });
  });

  // ─── Diff with arrays ────────────────────────────────────────────────────

  it('diff shows index-based paths', () => {
    const engine = new Engine({ items: ['a', 'b'] });
    engine.propose({ kind: 'replace', path: '/items/0', value: 'A' });
    const d = engine.diff();
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('/items/0');
    expect(d[0].value).toBe('A');
    expect(d[0].prev).toBe('a');
  });

  it('diff after remove shows correct indices', () => {
    const engine = new Engine({ items: [1, 2, 3] });
    engine.propose({ kind: 'remove', path: '/items/1' });
    const d = engine.diff();
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('/items/1');
    expect(d[0].kind).toBe('remove');
  });

  // ─── Apply with arrays ───────────────────────────────────────────────────

  it('apply folds array ops into base', () => {
    const engine = new Engine({ items: [1, 2] });
    engine.propose({ kind: 'add', path: '/items/-', value: 3 });
    engine.apply();
    expect(engine.export()).toEqual({ items: [1, 2, 3] });
    expect(engine.diff()).toEqual([]);
  });

  it('undo after apply restores array ops', () => {
    const engine = new Engine({ items: ['a', 'b'] });
    engine.propose({ kind: 'add', path: '/items/-', value: 'c' });
    engine.apply();
    engine.undo(); // undo apply
    engine.undo(); // undo propose
    expect(engine.export()).toEqual({ items: ['a', 'b'] });
  });

  // ─── Revert with arrays ──────────────────────────────────────────────────

  it('revert an array element edit', () => {
    const engine = new Engine({ items: [1, 2, 3] });
    engine.propose({ kind: 'replace', path: '/items/1', value: 99 });
    engine.revert('/items/1');
    expect(engine.export()).toEqual({ items: [1, 2, 3] });
    expect(engine.diff()).toEqual([]);
  });

  it('cascading revert removes descendant ops', () => {
    const engine = new Engine({ data: [] as unknown[] });
    engine.propose({ kind: 'add', path: '/data/-', value: { name: 'test' } });
    engine.propose({ kind: 'replace', path: '/data/0/name', value: 'updated' });
    engine.revert('/data/0');
    expect(engine.diff()).toEqual([]);
  });

  // ─── Index stability — the raison d'etre of keyed arrays ─────────────────

  it('ops on different elements survive index shifts from remove', () => {
    // This is THE test that would fail with naive positional indices.
    // Base: ['a', 'b', 'c', 'd']
    // Replace 'c' (index 2) with 'C'
    // Remove 'a' (index 0) — indices shift: 'b' is now 0, 'C' is now 1, 'd' is now 2
    // The replace should still target the original element ('c' → 'C'), not shift.
    const engine = new Engine({ items: ['a', 'b', 'c', 'd'] });
    engine.propose({ kind: 'replace', path: '/items/2', value: 'C' });
    engine.propose({ kind: 'remove', path: '/items/0' });
    expect(engine.export()).toEqual({ items: ['b', 'C', 'd'] });
  });

  it('undo of remove restores element at original position even with other ops', () => {
    const engine = new Engine({ items: ['a', 'b', 'c'] });
    engine.propose({ kind: 'replace', path: '/items/2', value: 'C' });
    engine.propose({ kind: 'remove', path: '/items/0' });
    // State: ['b', 'C']
    engine.undo(); // undo remove
    // State should be: ['a', 'b', 'C'] — 'a' is back, 'C' replacement still active
    expect(engine.export()).toEqual({ items: ['a', 'b', 'C'] });
  });

  it('multiple removes on same array target the right elements', () => {
    const engine = new Engine({ items: [10, 20, 30, 40, 50] });
    // Remove 20 (index 1)
    engine.propose({ kind: 'remove', path: '/items/1' });
    // Array is now effectively [10, 30, 40, 50]
    // Remove 40 (now at index 2)
    engine.propose({ kind: 'remove', path: '/items/2' });
    // Array should be [10, 30, 50]
    expect(engine.export()).toEqual({ items: [10, 30, 50] });
  });

  it('copilot proposes array ops, user approves', () => {
    const engine = new Engine({ tags: ['a', 'b'] });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/tags/-', value: 'c' });
    cs.approve('/tags/-');
    cs.end();
    engine.apply();
    expect(engine.export()).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('copilot replace on array element with user approve', () => {
    const engine = new Engine({ items: [1, 2, 3] });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/items/1', value: 99 });
    const d = cs.diff();
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('/items/1');
    expect(d[0].value).toBe(99);
    cs.approve('/items/1');
    cs.end();
    expect(engine.export()).toEqual({ items: [1, 99, 3] });
  });

  it('nested arrays', () => {
    const engine = new Engine({ matrix: [[1, 2], [3, 4]] });
    engine.propose({ kind: 'replace', path: '/matrix/1/0', value: 99 });
    expect(engine.export()).toEqual({ matrix: [[1, 2], [99, 4]] });
  });

  it('get returns correct value after index shift', () => {
    const engine = new Engine({ items: ['a', 'b', 'c'] });
    engine.propose({ kind: 'remove', path: '/items/0' });
    // After removing 'a': effective array is ['b', 'c']
    expect(engine.get('/items/0')).toBe('b');
    expect(engine.get('/items/1')).toBe('c');
    expect(engine.get('/items/2')).toBe(undefined);
  });

  it('add at specific index (insert)', () => {
    const engine = new Engine({ items: ['a', 'c'] });
    engine.propose({ kind: 'add', path: '/items/1', value: 'b' });
    expect(engine.export()).toEqual({ items: ['a', 'b', 'c'] });
  });
});
