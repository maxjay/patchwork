import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('KING — User is king auto-resolution rules', () => {
  it('KING-01: same path — user edit auto-declines copilot op', () => {
    const engine = new Engine({ timeout: 30 });
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/timeout', value: 60 });
    us.propose({ kind: 'replace', path: '/timeout', value: 45 });
    expect(cs.diff()).toEqual([]);
    expect(engine.get('/timeout')).toBe(45);
    expect(us.diff()).toHaveLength(1);
    expect(us.diff()[0].value).toBe(45);
  });

  it('KING-02: descendant — user edit auto-accepts copilot parent op', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    us.propose({ kind: 'add', path: '/server/port', value: 8080 });
    expect(cs.diff()).toEqual([]); // folded down
    expect(us.diff()).toHaveLength(2); // /server + /server/port
    expect(engine.get('/server/port')).toBe(8080);
  });

  it('KING-03: descendant auto-accept — undo reverses user edit only', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    us.propose({ kind: 'add', path: '/server/port', value: 8080 });
    us.undo(); // removes /server/port
    expect(us.diff()).toHaveLength(1); // /server remains
    expect(engine.get('/server')).toEqual({ host: 'x' });
  });

  it('KING-04: descendant auto-accept — second undo reverses the auto-accept', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    us.propose({ kind: 'add', path: '/server/port', value: 8080 });
    us.undo(); // removes /server/port
    us.undo(); // removes /server (auto-accepted)
    expect(us.diff()).toEqual([]);
    expect(engine.get('/server')).toBe(undefined);
  });

  it('KING-05: descendant auto-accept — revert parent cascades to child', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
    us.propose({ kind: 'add', path: '/server/port', value: 8080 });
    us.revert('/server');
    expect(us.diff()).toEqual([]); // both gone
    expect(engine.get('/server')).toBe(undefined);
  });

  it('KING-06: ancestor — user edit auto-declines copilot child op', () => {
    const engine = new Engine({ server: { port: 80 } });
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    us.propose({ kind: 'replace', path: '/server', value: { host: 'x' } });
    expect(cs.diff()).toEqual([]); // auto-declined
    expect(us.diff()).toHaveLength(1);
    expect(engine.get('/server')).toEqual({ host: 'x' });
  });

  it('KING-07: ancestor auto-decline cascades to subtree', () => {
    const engine = new Engine({ server: { port: 80, host: 'old' } });
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    cs.propose({ kind: 'replace', path: '/server/host', value: 'copilot' });
    us.propose({ kind: 'replace', path: '/server', value: { fresh: true } });
    expect(cs.diff()).toEqual([]); // BOTH auto-declined
    expect(us.diff()).toHaveLength(1);
    expect(engine.get('/server')).toEqual({ fresh: true });
  });

  it('KING-08: unrelated — both coexist', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/db/host', value: 'prod' });
    us.propose({ kind: 'add', path: '/cache/ttl', value: 300 });
    expect(cs.diff()).toHaveLength(1);
    expect(cs.diff()[0].conflictsWithUser).toBeUndefined();
    expect(engine.get('/db/host')).toBe('prod');
    expect(engine.get('/cache/ttl')).toBe(300);
  });
});
