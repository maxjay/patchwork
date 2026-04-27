import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';

describe('IDENTITY — One op per path', () => {
  it('IDENTITY-01: second propose at same path supersedes first', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.propose({ kind: 'replace', path: '/a', value: 3 });
    expect(engine.get('/a')).toBe(3);
    expect(engine.diff()).toHaveLength(1);
  });

  it('IDENTITY-02: revert after shadowing removes latest, not shadowed', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.propose({ kind: 'replace', path: '/a', value: 3 });
    engine.revert('/a');
    expect(engine.get('/a')).toBe(1);
    expect(engine.diff()).toEqual([]);
  });

  it('IDENTITY-03: undo after shadowing restores previous active op', () => {
    const engine = new Engine({ a: 1 });
    engine.propose({ kind: 'replace', path: '/a', value: 2 });
    engine.propose({ kind: 'replace', path: '/a', value: 3 });
    engine.undo();
    expect(engine.get('/a')).toBe(2);
    expect(engine.diff()).toHaveLength(1);
    expect(engine.diff()[0].value).toBe(2);
  });
});
