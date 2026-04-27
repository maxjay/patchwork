import { describe, it, expect } from 'vitest';
import { Engine, CopilotSessionOpenError } from '../src/index.js';

describe('APPLY — Apply and export', () => {
  it('apply with pending copilot session throws', () => {
    const engine = new Engine({ a: 1 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(() => engine.apply()).toThrow(CopilotSessionOpenError);
  });

  it('apply folds ops into base', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();
    expect(engine.get('/a')).toBe(2);
    expect(engine.export()).toEqual({ a: 2 });
    expect(engine.diff()).toEqual([]);
  });

  it('multiple applies accumulate on base', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();
    engine.propose({ kind: 'add', path: '/b', value: 10 });
    engine.apply();
    expect(engine.export()).toEqual({ a: 2, b: 10 });
  });

  it('apply with no ops is a no-op', () => {
    const engine = new Engine({ a: 1 });
    const v = engine.version;
    engine.apply();
    expect(engine.version).toBe(v); // no version bump
  });

  it('undo after apply restores the op and reverts the base', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();
    expect(engine.diff()).toEqual([]);
    expect(engine.get('/a')).toBe(2);

    engine.undo();
    expect(engine.diff()).toHaveLength(1);
    expect(engine.diff()[0].value).toBe(2);
    expect(engine.get('/a')).toBe(2); // still 2 — op is back in the active set
    // But the base is reverted to 1
    expect(engine.export()).toEqual({ a: 2 }); // base(1) + op(replace /a=2)
  });

  it('undo apply then undo the op itself restores original', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();

    engine.undo(); // undo the apply
    engine.undo(); // undo the propose

    expect(engine.get('/a')).toBe(1);
    expect(engine.diff()).toEqual([]);
    expect(engine.export()).toEqual({ a: 1 });
  });

  it('redo after undoing apply re-applies', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();
    engine.undo();
    engine.redo();

    expect(engine.diff()).toEqual([]);
    expect(engine.get('/a')).toBe(2);
    expect(engine.export()).toEqual({ a: 2 });
  });

  it('can keep editing after apply', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.apply();

    engine.propose({ kind: 'add', path: '/b', value: 'hello' });
    expect(engine.diff()).toHaveLength(1);
    expect(engine.export()).toEqual({ a: 2, b: 'hello' });
  });
});
