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

  it('user editing a copilot-proposed field auto-accepts it and preserves undo chain', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    const cs = engine.startCopilot();

    // Copilot proposes adding a name field
    cs.propose({ kind: 'add', path: '/server/name', value: 'jeff' });
    expect(engine.export()).toEqual({ server: { host: 'localhost', port: 8080, name: 'jeff' } });

    // User edits the copilot-proposed field in the editor
    engine.propose({ kind: 'replace', path: '/server/name', value: 'Hello' });

    // Copilot proposal should be gone (auto-accepted into user ops)
    expect(cs.diff()).toEqual([]);
    expect(engine.export()).toEqual({ server: { host: 'localhost', port: 8080, name: 'Hello' } });

    // Undo should go back to copilot's proposed value, not remove the field
    engine.undo();
    expect(engine.export()).toEqual({ server: { host: 'localhost', port: 8080, name: 'jeff' } });

    // Undo again removes the auto-accepted copilot op
    engine.undo();
    expect(engine.export()).toEqual({ server: { host: 'localhost', port: 8080 } });
  });

  it('user editing a descendant of copilot-proposed field auto-accepts parent', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    const cs = engine.startCopilot();

    // Copilot proposes adding a colour object
    cs.propose({ kind: 'add', path: '/server/colour', value: { r: 0, g: 0, b: 255 } });

    // User edits a child of the copilot-proposed object
    engine.propose({ kind: 'replace', path: '/server/colour/g', value: 120 });

    // Copilot proposal auto-accepted
    expect(cs.diff()).toEqual([]);
    expect(engine.export()).toEqual({
      server: { host: 'localhost', port: 8080, colour: { r: 0, g: 120, b: 255 } },
    });

    // Undo the user's edit
    engine.undo();
    expect(engine.export()).toEqual({
      server: { host: 'localhost', port: 8080, colour: { r: 0, g: 0, b: 255 } },
    });

    // Undo the auto-accept
    engine.undo();
    expect(engine.export()).toEqual({ server: { host: 'localhost', port: 8080 } });
  });
});
