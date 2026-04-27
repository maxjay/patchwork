import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('BASIC — Core engine mechanics', () => {
  it('BASIC-01: engine starts clean', () => {
    const engine = new Engine({ a: 1 });
    expect(engine.get('/a')).toBe(1);
    expect(engine.export()).toEqual({ a: 1 });
    expect(engine.diff()).toEqual([]);
  });

  it('BASIC-01b: export returns deep copy', () => {
    const engine = new Engine({ a: 1 });
    const e1 = engine.export();
    const e2 = engine.export();
    expect(e1).not.toBe(e2);
  });

  it('BASIC-04: propose a single op', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(engine.get('/a')).toBe(2);
    const d = engine.diff();
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('/a');
    expect(d[0].kind).toBe('replace');
    expect(d[0].value).toBe(2);
    expect(d[0].prev).toBe(1);
    expect(d[0].actor).toBe('user');
  });

  it('BASIC-05: apply folds ops into base, diff resets', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();
    expect(engine.get('/a')).toBe(2);
    expect(engine.export()).toEqual({ a: 2 });
    expect(engine.diff()).toEqual([]); // diff is clean
  });

  it('BASIC-07: base is not mutated by propose', () => {
    const base = { a: 1 };
    const engine = new Engine(base);
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(base.a).toBe(1);
  });

  it('BASIC-08: export returns deep copy', () => {
    const engine = new Engine({ nested: { a: 1 } });
    const exported = engine.export() as any;
    exported.nested.a = 999;
    expect(engine.get('/nested/a')).toBe(1);
  });
});
