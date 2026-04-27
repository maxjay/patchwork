import { describe, it, expect } from 'vitest';
import {
  Engine,
  CopilotAlreadyOpenError,
  NoOpAtPathError,
  SessionClosedError,
} from '../src/index.js';

describe('COPILOT — Propose, approve, decline', () => {
  it('COPILOT-01: copilot session nests inside engine', () => {
    const engine = new Engine({ a: 1 });
    const cs = engine.startCopilot();
    expect(engine.activeCopilotSession()).toBe(cs);
    expect(cs.diff()).toEqual([]);
  });

  it('COPILOT-03: only one copilot session at a time', () => {
    const engine = new Engine({ a: 1 });
    engine.startCopilot();
    expect(() => engine.startCopilot()).toThrow(CopilotAlreadyOpenError);
  });

  it('COPILOT-04: approve folds copilot op into user layer', () => {
    const engine = new Engine({ a: 1 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 2 });
    cs.approve('/a');
    expect(cs.diff()).toEqual([]);
    expect(engine.diff()).toHaveLength(1);
    expect(engine.diff()[0].path).toBe('/a');
    expect(engine.get('/a')).toBe(2);
  });

  it('COPILOT-05: decline drops copilot op without folding', () => {
    const engine = new Engine({ a: 1 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 2 });
    cs.decline('/a');
    expect(cs.diff()).toEqual([]);
    expect(engine.diff()).toEqual([]);
    expect(engine.get('/a')).toBe(1);
  });

  it('COPILOT-06: copilot session stays open after per-op approve', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/a', value: 1 });
    cs.propose({ kind: 'add', path: '/b', value: 2 });
    cs.approve('/a');
    expect(engine.activeCopilotSession()).toBe(cs);
    expect(cs.diff()).toHaveLength(1);
  });

  it('COPILOT-07: approveAll folds all ops and ends session', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/a', value: 1 });
    cs.propose({ kind: 'add', path: '/b', value: 2 });
    cs.approveAll();
    expect(engine.activeCopilotSession()).toBe(null);
    expect(engine.diff()).toHaveLength(2);
    expect(engine.get('/a')).toBe(1);
    expect(engine.get('/b')).toBe(2);
  });

  it('COPILOT-08: declineAll drops all ops and ends session', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/a', value: 1 });
    cs.propose({ kind: 'add', path: '/b', value: 2 });
    cs.declineAll();
    expect(engine.activeCopilotSession()).toBe(null);
    expect(engine.diff()).toEqual([]);
  });

  it('COPILOT-09: end() closes session with remaining ops dropped', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/a', value: 1 });
    cs.propose({ kind: 'add', path: '/b', value: 2 });
    cs.end();
    expect(engine.activeCopilotSession()).toBe(null);
    expect(engine.diff()).toEqual([]);
  });

  it('COPILOT-10: sequential copilot sessions after end', () => {
    const engine = new Engine({});
    const cs1 = engine.startCopilot();
    cs1.propose({ kind: 'add', path: '/a', value: 1 });
    cs1.approveAll();
    const cs2 = engine.startCopilot();
    expect(cs2.diff()).toEqual([]);
    expect(engine.diff()).toHaveLength(1);
  });

  it('ERROR-04: approve at a path not in copilot session throws', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    expect(() => cs.approve('/does-not-exist')).toThrow(NoOpAtPathError);
  });

  it('ERROR-05: operating on ended session throws', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.end();
    expect(() => cs.propose({ kind: 'add', path: '/a', value: 1 })).toThrow(SessionClosedError);
  });
});
