import { describe, it, expect } from 'vitest';
import { Engine, SessionAlreadyOpenError } from '../src/index.js';

describe('BASIC — Basic session mechanics', () => {
  it('BASIC-01: engine starts with no sessions', () => {
    const engine = new Engine({ a: 1 });
    expect(engine.get('/a')).toBe(1);
    expect(engine.activeUserSession()).toBe(null);
    expect(engine.export()).toEqual({ a: 1 });
  });

  it('BASIC-01: export returns deep copy', () => {
    const engine = new Engine({ a: 1 });
    const e1 = engine.export();
    const e2 = engine.export();
    expect(e1).not.toBe(e2);
  });

  it('BASIC-02: starting a user session', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    expect(engine.activeUserSession()).toBe(us);
    expect(us.diff()).toEqual([]);
  });

  it('BASIC-03: cannot start two user sessions', () => {
    const engine = new Engine({ a: 1 });
    engine.startUserSession();
    expect(() => engine.startUserSession()).toThrow(SessionAlreadyOpenError);
  });

  it('BASIC-04: propose a single op', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(engine.get('/a')).toBe(2);
    const d = us.diff();
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('/a');
    expect(d[0].kind).toBe('replace');
    expect(d[0].value).toBe(2);
    expect(d[0].prev).toBe(1);
    expect(d[0].actor).toBe('user');
  });

  it('BASIC-05: commit folds ops into base', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.commit();
    expect(engine.activeUserSession()).toBe(null);
    expect(engine.get('/a')).toBe(2);
    expect(engine.export()).toEqual({ a: 2 });
  });

  it('BASIC-06: discard throws ops away', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.discard();
    expect(engine.activeUserSession()).toBe(null);
    expect(engine.get('/a')).toBe(1);
    expect(engine.export()).toEqual({ a: 1 });
  });

  it('BASIC-07: base is not mutated by propose', () => {
    const base = { a: 1 };
    const engine = new Engine(base);
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(base.a).toBe(1);
  });

  it('BASIC-08: export returns deep copy', () => {
    const engine = new Engine({ nested: { a: 1 } });
    const exported = engine.export() as any;
    exported.nested.a = 999;
    expect(engine.get('/nested/a')).toBe(1);
  });
});
