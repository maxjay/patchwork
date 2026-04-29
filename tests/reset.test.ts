import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine.js';

describe('engine.reset()', () => {
  it('resets a field with its own op back to base', () => {
    const engine = new Engine({ port: 8080, host: 'localhost' });
    engine.propose({ kind: 'replace', path: '/port', value: 443 });
    expect(engine.get('/port')).toBe(443);

    engine.reset('/port');
    expect(engine.get('/port')).toBe(8080);
    expect(engine.getDiff('/port')).toBeNull();
  });

  it('is a no-op when the value already matches base', () => {
    const engine = new Engine({ port: 8080 });
    const v = engine.version;
    engine.reset('/port');
    expect(engine.version).toBe(v); // no bump
  });

  it('resets a field added by an ancestor op (compensating remove)', () => {
    const engine = new Engine({ server: { host: 'localhost' } });
    engine.propose({ kind: 'add', path: '/server/color', value: { r: 0, g: 0, b: 255 } });

    // /server/color/r exists because of the parent add — no op at /server/color/r
    expect(engine.get('/server/color/r')).toBe(0);
    expect(engine.getBase('/server/color/r')).toBeUndefined();

    engine.reset('/server/color/r');
    expect(engine.get('/server/color/r')).toBeUndefined();
  });

  it('resets a field modified by an ancestor op (compensating replace)', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    engine.propose({ kind: 'replace', path: '/server', value: { host: '0.0.0.0', port: 443 } });

    // Both host and port changed via the parent replace
    expect(engine.get('/server/host')).toBe('0.0.0.0');
    expect(engine.get('/server/port')).toBe(443);

    engine.reset('/server/host');
    expect(engine.get('/server/host')).toBe('localhost');
    // port should still be the replaced value
    expect(engine.get('/server/port')).toBe(443);
  });

  it('removes descendant ops along with the target', () => {
    const engine = new Engine({ server: { host: 'localhost', port: 8080 } });
    engine.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });
    engine.propose({ kind: 'replace', path: '/server/port', value: 443 });

    engine.reset('/server');
    expect(engine.get('/server/host')).toBe('localhost');
    expect(engine.get('/server/port')).toBe(8080);
    expect(engine.diff()).toHaveLength(0);
  });

  it('undo restores the pre-reset state', () => {
    const engine = new Engine({ port: 8080 });
    engine.propose({ kind: 'replace', path: '/port', value: 443 });
    engine.reset('/port');
    expect(engine.get('/port')).toBe(8080);

    engine.undo();
    expect(engine.get('/port')).toBe(443);
  });

  it('redo re-applies the reset', () => {
    const engine = new Engine({ port: 8080 });
    engine.propose({ kind: 'replace', path: '/port', value: 443 });
    engine.reset('/port');
    engine.undo();
    expect(engine.get('/port')).toBe(443);

    engine.redo();
    expect(engine.get('/port')).toBe(8080);
  });

  it('undo restores compensating op correctly', () => {
    const engine = new Engine({ server: { host: 'localhost' } });
    engine.propose({ kind: 'add', path: '/server/color', value: { r: 0, g: 0, b: 255 } });
    engine.reset('/server/color/r');
    expect(engine.get('/server/color/r')).toBeUndefined();

    engine.undo();
    expect(engine.get('/server/color/r')).toBe(0);
  });

  it('resets an added top-level field (removes it)', () => {
    const engine = new Engine({ port: 8080 });
    engine.propose({ kind: 'add', path: '/debug', value: true });
    expect(engine.get('/debug')).toBe(true);

    engine.reset('/debug');
    expect(engine.get('/debug')).toBeUndefined();
    expect(engine.getDiff('/debug')).toBeNull();
  });

  it('resets a removed field (restores it)', () => {
    const engine = new Engine({ port: 8080, debug: false });
    engine.propose({ kind: 'remove', path: '/debug' });
    expect(engine.get('/debug')).toBeUndefined();

    engine.reset('/debug');
    expect(engine.get('/debug')).toBe(false);
  });

  it('multiple resets + undos form a clean stack', () => {
    const engine = new Engine({ a: 1, b: 2, c: 3 });
    engine.propose({ kind: 'replace', path: '/a', value: 10 });
    engine.propose({ kind: 'replace', path: '/b', value: 20 });

    engine.reset('/a');
    engine.reset('/b');
    expect(engine.get('/a')).toBe(1);
    expect(engine.get('/b')).toBe(2);

    engine.undo(); // undo reset /b
    expect(engine.get('/b')).toBe(20);
    expect(engine.get('/a')).toBe(1);

    engine.undo(); // undo reset /a
    expect(engine.get('/a')).toBe(10);
    expect(engine.get('/b')).toBe(20);
  });
});
