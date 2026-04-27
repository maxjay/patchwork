import { describe, it, expect } from 'vitest';
import { Engine, CopilotSessionOpenError } from '../src/index.js';

describe('COMMIT — Commit, export, and session finalization', () => {
  it('COMMIT-01: commit with pending copilot session throws', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 2 });
    expect(() => us.commit()).toThrow(CopilotSessionOpenError);
  });

  it('COMMIT-02: commit folds user ops and ends session', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.commit();
    expect(engine.activeUserSession()).toBe(null);
    expect(engine.get('/a')).toBe(2);
    expect(engine.export()).toEqual({ a: 2 });
  });

  it('COMMIT-03: multiple commits accumulate on base', () => {
    const engine = new Engine({ a: 1 });
    const us1 = engine.startUserSession();
    us1.propose({ kind: 'replace', path: '/a', value: 2 });
    us1.commit();
    const us2 = engine.startUserSession();
    us2.propose({ kind: 'add', path: '/b', value: 10 });
    us2.commit();
    expect(engine.export()).toEqual({ a: 2, b: 10 });
  });

  it('COMMIT-04: discard leaves base unchanged', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.discard();
    expect(engine.get('/a')).toBe(1);
    expect(engine.export()).toEqual({ a: 1 });
  });
});
