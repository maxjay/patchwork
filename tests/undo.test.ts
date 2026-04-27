import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('UNDO — Undo and redo', () => {
  it('UNDO-01: undo single propose', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.undo();
    expect(engine.get('/a')).toBe(1);
    expect(us.diff()).toEqual([]);
  });

  it('UNDO-02: redo replays undone action', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.undo();
    us.redo();
    expect(engine.get('/a')).toBe(2);
  });

  it('UNDO-03: new action clears redo stack', () => {
    const engine = new Engine({ a: 1, b: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.undo();
    // redo stack has one entry; now a new action clears it
    us.propose({ kind: 'replace', path: '/b', value: 2 });
    us.redo(); // should be no-op
    expect(engine.get('/a')).toBe(1);
    expect(engine.get('/b')).toBe(2);
  });

  it('UNDO-04: undo is a no-op when stack is empty', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.undo(); // should not throw
    expect(engine.get('/a')).toBe(1);
  });

  it('UNDO-05: per-session stacks are isolated', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 10 });
    cs.undo();
    // Copilot undo doesn't touch user ops
    expect(engine.get('/a')).toBe(2); // user layer value
    expect(us.diff()).toHaveLength(1);
  });
});
