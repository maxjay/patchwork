import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('INTERACT — Cross-cutting interactions', () => {
  it('INTERACT-01: full happy-path flow', () => {
    const engine = new Engine({ timeout: 30, retries: 3 });
    engine.propose({ kind: 'replace', path: '/timeout', value: 45 });

    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/retries', value: 5 });
    cs.propose({ kind: 'add', path: '/logLevel', value: 'debug' });

    cs.approve('/retries');
    cs.decline('/logLevel');
    cs.end();

    engine.apply();
    expect(engine.export()).toEqual({ timeout: 45, retries: 5 });
  });

  it('INTERACT-02: user edit auto-accepts copilot then reverts the tree', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    engine.revert('/server');
    expect(engine.diff()).toEqual([]);
    expect(cs.diff()).toEqual([]);
    expect(engine.get('/server')).toBe(undefined);
  });

  it('INTERACT-03: undo across auto-accept boundary', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    engine.undo();
    engine.undo();
    expect(engine.diff()).toEqual([]);
    expect(engine.get('/server')).toBe(undefined);
  });

  it('INTERACT-04: conflict flag then user override in sequence', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 3 });
    engine.propose({ kind: 'replace', path: '/a', value: 4 });
    expect(cs.diff()).toEqual([]);
    expect(engine.get('/a')).toBe(4);
  });
});
