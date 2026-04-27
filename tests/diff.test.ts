import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('DIFF — Diffs and diffTree', () => {
  it('DIFF-01: empty session has empty diff', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    expect(us.diff()).toEqual([]);
    expect(us.diffTree().children.size).toBe(0);
  });

  it('DIFF-02: diff returns insertion order', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/b', value: 2 });
    us.propose({ kind: 'add', path: '/a', value: 1 });
    us.propose({ kind: 'add', path: '/c', value: 3 });
    expect(us.diff().map((o) => o.path)).toEqual(['/b', '/a', '/c']);
  });

  it('DIFF-03: diffTree groups by path subtree', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    us.propose({ kind: 'add', path: '/db/host', value: 'x' });
    us.propose({ kind: 'add', path: '/cache/ttl', value: 300 });
    us.propose({ kind: 'add', path: '/db/port', value: 5432 });
    const tree = us.diffTree();
    expect(tree.children.has('db')).toBe(true);
    expect(tree.children.has('cache')).toBe(true);
    const db = tree.children.get('db')!;
    expect(db.children.has('host')).toBe(true);
    expect(db.children.has('port')).toBe(true);
    const cache = tree.children.get('cache')!;
    expect(cache.children.has('ttl')).toBe(true);
  });

  it('DIFF-04: copilot diff is against user session, not base', () => {
    const engine = new Engine({ a: 1 });
    const us = engine.startUserSession();
    us.propose({ kind: 'replace', path: '/a', value: 2 });
    const cs = us.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 3 });
    expect(cs.diff()[0].prev).toBe(2); // prev is user-layer, not base
    expect(cs.diff()[0].value).toBe(3);
    expect(cs.diff()[0].conflictsWithUser).toBe(true);
  });
});
