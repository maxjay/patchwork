import { describe, it, expect } from 'vitest';
import { Engine, NoOpAtPathError } from '../src/index.js';

describe('CASCADE — Cascading revert', () => {
  it('CASCADE-01: revert parent removes children', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: 5 });
    us.revert('/a');
    expect(engine.get('/a')).toBe(undefined);
    expect(us.diff()).toEqual([]);
  });

  it('CASCADE-02: undo after cascade restores both ops together', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: 5 });
    us.revert('/a');
    us.undo(); // restores both /a and /a/b
    expect(engine.get('/a/b')).toBe(5);
    expect(us.diff()).toHaveLength(2);
  });

  it('CASCADE-03: redo replays cascade as one action', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: 5 });
    us.revert('/a');
    us.undo();
    us.redo(); // re-removes both
    expect(engine.get('/a')).toBe(undefined);
    expect(us.diff()).toEqual([]);
  });

  it('CASCADE-04: revert child does not affect parent', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: 5 });
    us.revert('/a/b');
    expect(us.diff()).toHaveLength(1);
    expect(engine.get('/a')).toEqual({});
    expect(engine.get('/a/b')).toBe(undefined);
  });

  it('CASCADE-05: revert of untouched path throws', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    expect(() => us.revert('/a')).toThrow(NoOpAtPathError);
  });

  it('CASCADE-06: deep cascade (multi-level descendants)', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: {} });
    us.propose({ kind: 'add', path: '/a/b/c', value: 5 });
    us.propose({ kind: 'add', path: '/a/b/d', value: 6 });
    us.propose({ kind: 'add', path: '/a/e', value: 7 });
    us.revert('/a');
    expect(engine.get('/a')).toBe(undefined);
    expect(us.diff()).toEqual([]);
  });

  it('CASCADE-07: revert of mid-level subtree', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: {} });
    us.propose({ kind: 'add', path: '/a/b', value: {} });
    us.propose({ kind: 'add', path: '/a/b/c', value: 5 });
    us.propose({ kind: 'add', path: '/a/b/d', value: 6 });
    us.propose({ kind: 'add', path: '/a/e', value: 7 });
    us.revert('/a/b');
    expect(us.diff()).toHaveLength(2); // /a and /a/e remain
    expect(engine.get('/a/b')).toBe(undefined);
  });
});
