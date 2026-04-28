import { describe, it, expect } from 'vitest';
import { Engine, PathNotFoundError } from '../src/index.js';

describe('MOVE — Rename and move operations', () => {
  it('renames a key within the same parent', () => {
    const engine = new Engine({ host: 'localhost', port: 8080 });
    engine.move('/host', '/hostname');
    expect(engine.export()).toEqual({ hostname: 'localhost', port: 8080 });
  });

  it('moves a value to a different parent', () => {
    const engine = new Engine({ server: { host: 'localhost' }, config: {} });
    engine.move('/server/host', '/config/host');
    expect(engine.export()).toEqual({ server: {}, config: { host: 'localhost' } });
  });

  it('moves an entire subtree', () => {
    const engine = new Engine({ old: { a: 1, b: 2 }, new: {} });
    engine.move('/old', '/new/data');
    expect(engine.export()).toEqual({ new: { data: { a: 1, b: 2 } } });
  });

  it('move is one undo step', () => {
    const engine = new Engine({ host: 'localhost', port: 8080 });
    engine.move('/host', '/hostname');
    engine.undo();
    expect(engine.export()).toEqual({ host: 'localhost', port: 8080 });
  });

  it('move can be redone', () => {
    const engine = new Engine({ host: 'localhost', port: 8080 });
    engine.move('/host', '/hostname');
    engine.undo();
    engine.redo();
    expect(engine.export()).toEqual({ hostname: 'localhost', port: 8080 });
  });

  it('move after propose preserves other ops', () => {
    const engine = new Engine({ a: 1, b: 2 });
    engine.propose({ kind: 'replace', path: '/b', value: 99 });
    engine.move('/a', '/c');
    expect(engine.export()).toEqual({ b: 99, c: 1 });
  });

  it('move includes descendant op values in moved subtree', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    engine.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });
    engine.move('/server', '/config');
    expect(engine.export()).toEqual({ config: { host: '0.0.0.0', port: 8080 } });
  });

  it('undo of move with descendant ops restores them', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    engine.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });
    engine.move('/server', '/config');
    engine.undo();
    // The descendant op on /server/host should be restored
    expect(engine.export()).toEqual({ server: { host: '0.0.0.0', port: 8080 } });
  });

  it('diff shows remove + add for a move', () => {
    const engine = new Engine({ a: 1, b: 2 });
    engine.move('/a', '/c');
    const d = engine.diff();
    expect(d).toHaveLength(2);
    expect(d.find(op => op.kind === 'remove')?.path).toBe('/a');
    expect(d.find(op => op.kind === 'add')?.path).toBe('/c');
  });

  it('throws when moving a non-existent path', () => {
    const engine = new Engine({ a: 1 });
    expect(() => engine.move('/nope', '/b')).toThrow(PathNotFoundError);
  });

  it('copilot can propose a move', () => {
    const engine = new Engine({ host: 'localhost', port: 8080 });
    const cs = engine.startCopilot();
    cs.move('/host', '/hostname');
    const d = cs.diff();
    expect(d).toHaveLength(2);
    cs.approveAll();
    expect(engine.export()).toEqual({ hostname: 'localhost', port: 8080 });
  });
});
