import { describe, it, expect } from 'vitest';
import { Engine, ValidationError } from '../src/index.js';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    mode: { enum: ['dev', 'staging', 'prod'] },
    server: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        timeout: { type: 'integer', minimum: 0 },
      },
      required: ['host'],
      additionalProperties: false,
    },
  },
  required: ['name', 'port'],
  additionalProperties: false,
};

const BASE = { name: 'my-service', port: 8080 };

describe('VALIDATION — Schema validation', () => {
  it('VAL-01: valid base passes construction', () => {
    expect(() => new Engine(BASE, SCHEMA)).not.toThrow();
  });

  it('VAL-02: invalid base throws ValidationError on construction', () => {
    expect(() => new Engine({ name: 123, port: 8080 }, SCHEMA)).toThrow(ValidationError);
  });

  it('VAL-03: missing required field in base throws', () => {
    expect(() => new Engine({ name: 'x' }, SCHEMA)).toThrow(ValidationError);
  });

  it('VAL-04: valid propose succeeds', () => {
    const engine = new Engine(BASE, SCHEMA);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 443 })).not.toThrow();
    expect(engine.get('/port')).toBe(443);
  });

  it('VAL-05: propose with wrong type throws, op not staged', () => {
    const engine = new Engine(BASE, SCHEMA);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 'not-a-number' })).toThrow(ValidationError);
    expect(engine.get('/port')).toBe(8080);
    expect(engine.diff()).toHaveLength(0);
  });

  it('VAL-06: propose below minimum throws, state unchanged', () => {
    const engine = new Engine(BASE, SCHEMA);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 0 })).toThrow(ValidationError);
    expect(engine.get('/port')).toBe(8080);
  });

  it('VAL-07: adding disallowed field throws (additionalProperties: false)', () => {
    const engine = new Engine(BASE, SCHEMA);
    expect(() => engine.propose({ kind: 'add', path: '/extra', value: 'x' })).toThrow(ValidationError);
    expect(engine.diff()).toHaveLength(0);
  });

  it('VAL-08: enum violation throws', () => {
    const engine = new Engine({ ...BASE, mode: 'dev' }, SCHEMA);
    expect(() => engine.propose({ kind: 'replace', path: '/mode', value: 'invalid' })).toThrow(ValidationError);
    expect(engine.get('/mode')).toBe('dev');
  });

  it('VAL-09: second propose after rollback still works', () => {
    const engine = new Engine(BASE, SCHEMA);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 'bad' })).toThrow(ValidationError);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 9000 })).not.toThrow();
    expect(engine.get('/port')).toBe(9000);
  });

  it('VAL-10: ValidationError carries error details', () => {
    const engine = new Engine(BASE, SCHEMA);
    try {
      engine.propose({ kind: 'replace', path: '/port', value: 'bad' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.errors.length).toBeGreaterThan(0);
      expect(ve.errors[0].path).toBeDefined();
      expect(ve.errors[0].message).toBeDefined();
    }
  });

  it('VAL-11: no schema = no validation, anything goes', () => {
    const engine = new Engine(BASE);
    expect(() => engine.propose({ kind: 'replace', path: '/port', value: 'whatever' })).not.toThrow();
    expect(() => engine.propose({ kind: 'add', path: '/anything', value: true })).not.toThrow();
  });

  it('VAL-12: valid move passes', () => {
    const engine = new Engine({ name: 'svc', port: 8080, mode: 'dev' }, SCHEMA);
    // move is disallowed by additionalProperties, so test with a schema that allows it
    const flexSchema = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } };
    const e2 = new Engine({ a: 1 }, flexSchema);
    expect(() => e2.move('/a', '/b')).not.toThrow();
    expect(e2.get('/b')).toBe(1);
  });

  it('VAL-13: move that violates schema throws, state unchanged', () => {
    const engine = new Engine({ name: 'svc', port: 8080 }, SCHEMA);
    expect(() => engine.move('/name', '/renamed')).toThrow(ValidationError);
    expect(engine.get('/name')).toBe('svc');
    expect(engine.get('/renamed')).toBeUndefined();
  });

  it('VAL-14: copilot propose validates too', () => {
    const engine = new Engine(BASE, SCHEMA);
    const session = engine.startCopilot();
    expect(() => session.propose({ kind: 'replace', path: '/port', value: 'bad' })).toThrow(ValidationError);
    expect(session.diff()).toHaveLength(0);
  });

  it('VAL-15: valid copilot propose passes', () => {
    const engine = new Engine(BASE, SCHEMA);
    const session = engine.startCopilot();
    expect(() => session.propose({ kind: 'replace', path: '/port', value: 443 })).not.toThrow();
    expect(session.diff()).toHaveLength(1);
  });
});
