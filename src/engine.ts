import type { EngineOptions } from './types.js';
import { SessionAlreadyOpenError } from './errors.js';
import { UserSession } from './session.js';
import { getByPath } from './pointer.js';
import { deepCopy } from './util.js';

export class Engine<T = unknown> {
  private _base: T;
  private _userSession: UserSession | null = null;
  private _version = 0;
  private _opts: EngineOptions<T>;

  constructor(base: T, opts?: EngineOptions<T>) {
    this._base = deepCopy(base);
    this._opts = opts ?? {};
  }

  get version(): number {
    return this._version;
  }

  /** Increment version — called by sessions on every state change. */
  _bump(): void {
    this._version++;
  }

  /** The immutable base config. Sessions read through this. */
  _getBase(): T {
    return this._base;
  }

  /** Fold committed ops into the base. Called by UserSession.commit(). */
  _setBase(next: T): void {
    this._base = next;
  }

  /** Clear the user session reference. Called by commit/discard. */
  _clearUserSession(): void {
    this._userSession = null;
  }

  get(path: string): unknown {
    // Walk layers top-down: copilot → user → base
    if (this._userSession) {
      const copilot = this._userSession._copilotSession;
      if (copilot) {
        const cop = copilot._getActiveOp(path);
        if (cop) return cop.kind === 'remove' ? undefined : cop.value;
      }
      const uop = this._userSession._getActiveOp(path);
      if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    }
    return getByPath(this._base, path);
  }

  /**
   * Compute the full effective config: base + user ops + copilot ops.
   * This is used internally for building the complete picture.
   */
  _effectiveBase(): unknown {
    return deepCopy(this._base);
  }

  startUserSession(): UserSession {
    if (this._userSession) throw new SessionAlreadyOpenError();
    this._userSession = new UserSession(this as Engine<unknown>);
    this._bump();
    return this._userSession;
  }

  activeUserSession(): UserSession | null {
    return this._userSession;
  }

  export(): T {
    if (!this._userSession) return deepCopy(this._base);

    // Apply user session ops over base
    let result: unknown = deepCopy(this._base);
    for (const op of this._userSession._activeOps()) {
      result = applyOp(result, op);
    }

    // Apply copilot session ops if any
    const copilot = this._userSession._copilotSession;
    if (copilot) {
      for (const op of copilot._activeOps()) {
        result = applyOp(result, op);
      }
    }

    return result as T;
  }
}

import { parsePath, setBySegments, removeBySegments } from './pointer.js';
import type { Op } from './types.js';

/** Apply a single op to a plain JSON value, returning the new value. */
export function applyOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'remove') {
    return removeBySegments(obj, segments);
  }
  // add or replace
  return setBySegments(obj, segments, op.value);
}
