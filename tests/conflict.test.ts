import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('CONFLICT — Copilot proposes into user-touched territory', () => {
  it('CONFLICT-01: same path — flagged', () => {
    const engine = new Engine({ timeout: 30 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/timeout', value: 45 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/timeout', value: 60 });
    expect(cs.diff()[0].conflictsWithUser).toBe(true);
    expect(engine.get('/timeout')).toBe(60); // copilot layer on top
  });

  it('CONFLICT-02: approving a conflict clobbers user edit (last-write-wins)', () => {
    const engine = new Engine({ timeout: 30 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/timeout', value: 45 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/timeout', value: 60 });
    cs.approve('/timeout');
    expect(engine.get('/timeout')).toBe(60);
    expect(us.diff()).toHaveLength(1);
    expect(us.diff()[0].value).toBe(60);
  });

  it('CONFLICT-03: declining a conflict preserves user edit', () => {
    const engine = new Engine({ timeout: 30 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/timeout', value: 45 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/timeout', value: 60 });
    cs.decline('/timeout');
    expect(engine.get('/timeout')).toBe(45);
    expect(us.diff()).toHaveLength(1);
    expect(us.diff()[0].value).toBe(45);
  });

  it('CONFLICT-04: ancestor overlap (user edited ancestor, copilot proposes descendant)', () => {
    const engine = new Engine({ server: { port: 80 } });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/server', value: { host: 'x' } });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    expect(cs.diff()[0].conflictsWithUser).toBe(true);
  });

  it('CONFLICT-05: descendant overlap (user edited descendant, copilot proposes ancestor)', () => {
    const engine = new Engine({ server: { port: 80 } });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/server/port', value: 8080 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/server', value: { host: 'x' } });
    expect(cs.diff()[0].conflictsWithUser).toBe(true);
  });

  it('CONFLICT-06: no flag when paths unrelated', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/a', value: 1 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'add', path: '/b', value: 2 });
    expect(cs.diff()[0].conflictsWithUser).toBeUndefined();
  });
});
