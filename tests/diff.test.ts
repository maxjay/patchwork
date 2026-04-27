import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('DIFF — Diffs and diffTree', () => {
  it('DIFF-01: no ops means empty diff', () => {
    const engine = new Engine({ a: 1 });
    expect(engine.diff()).toEqual([]);
    expect(engine.diffTree().children.size).toBe(0);
  });

  it('DIFF-02: diff returns insertion order', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/b', value: 2 });
    engine.propose({ kind: 'add', path: '/a', value: 1 });
    engine.propose({ kind: 'add', path: '/c', value: 3 });
    expect(engine.diff().map((o) => o.path)).toEqual(['/b', '/a', '/c']);
  });

  it('DIFF-03: diffTree groups by path subtree', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'add', path: '/db/host', value: 'x' });
    engine.propose({ kind: 'add', path: '/cache/ttl', value: 300 });
    engine.propose({ kind: 'add', path: '/db/port', value: 5432 });
    const tree = engine.diffTree();
    expect(tree.children.has('db')).toBe(true);
    expect(tree.children.has('cache')).toBe(true);
    const db = tree.children.get('db')!;
    expect(db.children.has('host')).toBe(true);
    expect(db.children.has('port')).toBe(true);
  });

  it('DIFF-04: copilot diff is against user layer, not base', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    const cs = engine.startCopilot();
    cs.propose({ kind: 'replace', path: '/a', value: 3 });
    expect(cs.diff()[0].prev).toBe(2);
    expect(cs.diff()[0].value).toBe(3);
    expect(cs.diff()[0].conflictsWithUser).toBe(true);
  });
});
