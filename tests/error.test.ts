import { describe, it, expect } from 'vitest';
import { Engine, InvalidPathError, PathNotFoundError } from '../src/index.js';

describe('ERROR — Error cases', () => {
  it('ERROR-01: propose with invalid path (malformed pointer)', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    expect(() => us.propose({ kind: 'add', path: 'not-a-pointer', value: 1 })).toThrow(
      InvalidPathError,
    );
  });

  it('ERROR-03: remove at a path that does not exist', () => {
    const engine = new Engine({});
    const us = engine.startUserSession();
    expect(() => us.propose({ kind: 'remove', path: '/a' })).toThrow(PathNotFoundError);
  });
});
