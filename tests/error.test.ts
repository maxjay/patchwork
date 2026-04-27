import { describe, it, expect } from 'vitest';
import { Engine, InvalidPathError, PathNotFoundError } from '../src/index.js';

describe('ERROR — Error cases', () => {
  it('ERROR-01: propose with invalid path', () => {
    const engine = new Engine({});
    expect(() => engine.propose({ kind: 'add', path: 'not-a-pointer', value: 1 })).toThrow(
      InvalidPathError,
    );
  });

  it('ERROR-03: remove at a path that does not exist is a no-op', () => {
    const engine = new Engine({});
    engine.propose({ kind: 'remove', path: '/a' });
    expect(engine.diff()).toEqual([]);
  });
});
