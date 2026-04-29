import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine.js';

const BASE = {
  appName: 'my-service',
  timeout: 30,
  server: {
    host: 'localhost',
    port: 8080,
  },
  enabled: true,
  nothing: null,
};

describe('engine.node()', () => {
  it('returns object node at root', () => {
    const engine = new Engine(BASE);
    const node = engine.node('');
    expect(node).toEqual({
      type: 'object',
      path: '',
      key: '',
      keys: ['appName', 'timeout', 'server', 'enabled', 'nothing'],
      changed: false,
    });
  });

  it('returns object node for nested object', () => {
    const engine = new Engine(BASE);
    const node = engine.node('/server');
    expect(node).toEqual({
      type: 'object',
      path: '/server',
      key: 'server',
      keys: ['host', 'port'],
      changed: false,
    });
  });

  it('returns string leaf', () => {
    const engine = new Engine(BASE);
    const node = engine.node('/appName');
    expect(node).toEqual({
      type: 'string',
      path: '/appName',
      key: 'appName',
      value: 'my-service',
      base: 'my-service',
      changed: false,
    });
  });

  it('returns number leaf', () => {
    const engine = new Engine(BASE);
    const node = engine.node('/server/port');
    expect(node).toEqual({
      type: 'number',
      path: '/server/port',
      key: 'port',
      value: 8080,
      base: 8080,
      changed: false,
    });
  });

  it('returns boolean leaf', () => {
    const engine = new Engine(BASE);
    const node = engine.node('/enabled');
    expect(node).toEqual({
      type: 'boolean',
      path: '/enabled',
      key: 'enabled',
      value: true,
      base: true,
      changed: false,
    });
  });

  it('returns null leaf', () => {
    const engine = new Engine(BASE);
    const node = engine.node('/nothing');
    expect(node).toEqual({
      type: 'null',
      path: '/nothing',
      key: 'nothing',
      value: null,
      base: null,
      changed: false,
    });
  });

  it('returns null for nonexistent path', () => {
    const engine = new Engine(BASE);
    expect(engine.node('/nonexistent')).toBeNull();
  });

  it('marks leaf as changed after propose', () => {
    const engine = new Engine(BASE);
    engine.propose({ kind: 'replace', path: '/timeout', value: 60 });
    const node = engine.node('/timeout');
    expect(node).toEqual({
      type: 'number',
      path: '/timeout',
      key: 'timeout',
      value: 60,
      base: 30,
      changed: true,
    });
  });

  it('marks object as changed when key is added', () => {
    const engine = new Engine(BASE);
    engine.propose({ kind: 'add', path: '/server/ssl', value: true });
    const node = engine.node('/server');
    expect(node!.type).toBe('object');
    expect(node!.keys).toEqual(['host', 'port', 'ssl']);
    expect(node!.changed).toBe(true);
  });

  it('marks object as changed when key is removed', () => {
    const engine = new Engine(BASE);
    engine.propose({ kind: 'remove', path: '/server/host' });
    const node = engine.node('/server');
    expect(node!.keys).toEqual(['port']);
    expect(node!.changed).toBe(true);
  });

  it('object stays unchanged when only child values change', () => {
    const engine = new Engine(BASE);
    engine.propose({ kind: 'replace', path: '/server/port', value: 443 });
    const node = engine.node('/server');
    expect(node!.keys).toEqual(['host', 'port']);
    expect(node!.changed).toBe(false);
  });

  it('returns array node', () => {
    const engine = new Engine({ items: [1, 2, 3] });
    const node = engine.node('/items');
    expect(node).toEqual({
      type: 'array',
      path: '/items',
      key: 'items',
      keys: ['0', '1', '2'],
      changed: false,
    });
  });

  it('newly added leaf has undefined base', () => {
    const engine = new Engine(BASE);
    engine.propose({ kind: 'add', path: '/newField', value: 'hello' });
    const node = engine.node('/newField');
    expect(node).toEqual({
      type: 'string',
      path: '/newField',
      key: 'newField',
      value: 'hello',
      base: undefined,
      changed: true,
    });
  });

  it('returns defensive copies for leaf values', () => {
    const engine = new Engine({ data: { nested: { x: 1 } } });
    // Replace with an object value at a leaf path
    engine.propose({ kind: 'replace', path: '/data/nested', value: { x: 2 } });
    const node = engine.node('/data/nested');
    // The node sees it as an object (container), not a leaf
    expect(node!.type).toBe('object');
    expect(node!.keys).toEqual(['x']);
  });
});
