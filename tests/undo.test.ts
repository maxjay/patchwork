import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('UNDO — Undo and redo', () => {
  it('UNDO-01: undo single propose', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.undo();
    expect(engine.get('/a')).toBe(1);
    expect(engine.diff()).toEqual([]);
  });

  it('UNDO-02: redo replays undone action', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.undo();
    engine.redo();
    expect(engine.get('/a')).toBe(2);
  });

  it('UNDO-03: new action clears redo stack', () => {
    const engine = new Engine({ a: 1, b: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.undo();
    engine.propose({ kind: 'replace', path: '/b', value: 2 });
    engine.redo(); // no-op
    expect(engine.get('/a')).toBe(1);
    expect(engine.get('/b')).toBe(2);
  });

  it('UNDO-04: undo is a no-op when stack is empty', () => {
    const engine = new Engine({ a: 1 });
    engine.undo();
    expect(engine.get('/a')).toBe(1);
  });

  it('UNDO-05: copilot undo is isolated from user ops', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 10 });
    cs.undo();
    expect(engine.get('/a')).toBe(2); // user layer value
    expect(engine.diff()).toHaveLength(1);
  });
});
