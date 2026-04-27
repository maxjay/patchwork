import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('KING — User is king auto-resolution rules', () => {
  it('KING-01: same path — user edit auto-declines copilot op', () => {
    const engine = new Engine({ timeout: 30 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/timeout', value: 60 });
    engine.propose({ kind: 'replace', path: '/timeout', value: 45 });
    expect(cs.diff()).toEqual([]);
    expect(engine.get('/timeout')).toBe(45);
    expect(engine.diff()).toHaveLength(1);
    expect(engine.diff()[0].value).toBe(45);
  });

  it('KING-02: descendant — user edit auto-accepts copilot parent op', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    expect(cs.diff()).toEqual([]);
    expect(engine.diff()).toHaveLength(2);
    expect(engine.get('/server/port')).toBe(8080);
  });

  it('KING-03: descendant auto-accept — undo reverses user edit only', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    engine.undo();
    expect(engine.diff()).toHaveLength(1);
    expect(engine.get('/server')).toEqual({ host: 'x' });
  });

  it('KING-04: descendant auto-accept — second undo reverses the auto-accept', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    engine.undo();
    engine.undo();
    expect(engine.diff()).toEqual([]);
    expect(engine.get('/server')).toBe(undefined);
  });

  it('KING-05: descendant auto-accept — revert parent cascades to child', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    engine.propose({ kind: 'add', path: '/server/port', value: 8080 });
    engine.revert('/server');
    expect(engine.diff()).toEqual([]);
    expect(engine.get('/server')).toBe(undefined);
  });

  it('KING-06: ancestor — user edit auto-declines copilot child op', () => {
    const engine = new Engine({ server: { port: 80 } });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    engine.propose({ kind: 'replace', path: '/server', value: { host: 'x' } });
    expect(cs.diff()).toEqual([]);
    expect(engine.diff()).toHaveLength(1);
    expect(engine.get('/server')).toEqual({ host: 'x' });
  });

  it('KING-07: ancestor auto-decline cascades to subtree', () => {
    const engine = new Engine({ server: { port: 80, host: 'old' } });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    cs.propose({ kind: 'replace', path: '/server/host', value: 'copilot' });
    engine.propose({ kind: 'replace', path: '/server', value: { fresh: true } });
    expect(cs.diff()).toEqual([]);
    expect(engine.diff()).toHaveLength(1);
    expect(engine.get('/server')).toEqual({ fresh: true });
  });

  it('KING-08: unrelated — both coexist', () => {
    const engine = new Engine({});
    const cs = engine.startCopilot();
    cs.propose({ kind: 'add', path: '/db/host', value: 'prod' });
    engine.propose({ kind: 'add', path: '/cache/ttl', value: 300 });
    expect(cs.diff()).toHaveLength(1);
    expect(cs.diff()[0].conflictsWithUser).toBeUndefined();
    expect(engine.get('/db/host')).toBe('prod');
    expect(engine.get('/cache/ttl')).toBe(300);
  });
});
