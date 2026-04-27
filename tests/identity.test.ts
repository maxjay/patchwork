import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('IDENTITY — One op per path per session', () => {
  it('IDENTITY-01: second propose at same path supersedes first', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.propose({ kind: 'replace', path: '/a', value: 3 });
    expect(engine.get('/a')).toBe(3);
    expect(us.diff()).toHaveLength(1);
  });

  it('IDENTITY-02: revert after shadowing removes latest, not shadowed', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.propose({ kind: 'replace', path: '/a', value: 3 });
    us.revert('/a');
    expect(engine.get('/a')).toBe(1); // back to base, NOT value 2
    expect(us.diff()).toEqual([]);
  });

  it('IDENTITY-03: undo after shadowing restores previous active op', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    us.propose({ kind: 'replace', path: '/a', value: 3 });
    us.undo();
    expect(engine.get('/a')).toBe(2); // shadowed op becomes active again
    expect(us.diff()).toHaveLength(1);
    expect(us.diff()[0].value).toBe(2);
  });
});
