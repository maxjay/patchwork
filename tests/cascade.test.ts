import { describe, it, expect } from 'vitest';
import { Engine, NoOpAtPathError } from '../src/index.js';

describe('CASCADE — Cascading revert', () => {
  it('CASCADE-01: revert parent removes children', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: 5 });
    engine.revert('/a');
    expect(engine.get('/a')).toBe(undefined);
    expect(engine.diff()).toEqual([]);
  });

  it('CASCADE-02: undo after cascade restores both ops together', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: 5 });
    engine.revert('/a');
    engine.undo();
    expect(engine.get('/a/b')).toBe(5);
    expect(engine.diff()).toHaveLength(2);
  });

  it('CASCADE-03: redo replays cascade as one action', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: 5 });
    engine.revert('/a');
    engine.undo();
    engine.redo();
    expect(engine.get('/a')).toBe(undefined);
    expect(engine.diff()).toEqual([]);
  });

  it('CASCADE-04: revert child does not affect parent', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: 5 });
    engine.revert('/a/b');
    expect(engine.diff()).toHaveLength(1);
    expect(engine.get('/a')).toEqual({});
    expect(engine.get('/a/b')).toBe(undefined);
  });

  it('CASCADE-05: revert of untouched path throws', () => {
    const engine = new Engine({ a: 1 });
    expect(() => engine.revert('/a')).toThrow(NoOpAtPathError);
  });

  it('CASCADE-06: deep cascade (multi-level descendants)', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: {} });
    engine.propose({ kind: 'add', path: '/a/b/c', value: 5 });
    engine.propose({ kind: 'add', path: '/a/b/d', value: 6 });
    engine.propose({ kind: 'add', path: '/a/e', value: 7 });
    engine.revert('/a');
    expect(engine.get('/a')).toBe(undefined);
    expect(engine.diff()).toEqual([]);
  });

  it('CASCADE-07: revert of mid-level subtree', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/a', value: {} });
    engine.propose({ kind: 'add', path: '/a/b', value: {} });
    engine.propose({ kind: 'add', path: '/a/b/c', value: 5 });
    engine.propose({ kind: 'add', path: '/a/b/d', value: 6 });
    engine.propose({ kind: 'add', path: '/a/e', value: 7 });
    engine.revert('/a/b');
    expect(engine.diff()).toHaveLength(2);
    expect(engine.get('/a/b')).toBe(undefined);
  });
});
