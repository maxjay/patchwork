import type { Op, OpInput, Action, DiffEntry, DiffTreeNode, EngineOptions } from './types.js';
import { isKeyedArray } from './types.js';
import {
  CopilotAlreadyOpenError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  PathNotFoundError,
} from './errors.js';
import {
  parsePath,
  getBySegments,
  setBySegments,
  removeBySegments,
  isAncestor,
  isDescendant,
  pathsOverlap,
  keyify,
  unkeyify,
  resolveToKeyed,
  resolveToIndex,
} from './pointer.js';
import { CopilotSession } from './copilot.js';
import { deepCopy } from './util.js';

export class Engine<T = unknown> {
  private _base: unknown; // keyed representation
  private _ops: Map<string, Op> = new Map(); // key-based paths
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _version = 0;
  private _opts: EngineOptions<T>;
  /** @internal — monotonic counter for keyed array element IDs. */
  _nextKey: number;

  /** @internal */
  _copilotSession: CopilotSession | null = null;

  constructor(base: T, opts?: EngineOptions<T>) {
    const result = keyify(deepCopy(base), 0);
    this._base = result.value;
    this._nextKey = result.counter;
    this._opts = opts ?? {};
  }

  get version(): number {
    return this._version;
  }

  /** @internal — increment version on every state change. */
  _bump(): void {
    this._version++;
  }

  /** @internal */
  _getBase(): unknown {
    return this._base;
  }

  /** @internal */
  _setBase(next: unknown): void {
    this._base = next;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  get(path: string): unknown {
    // Build full effective keyed state, then read from it
    const keyedState = this._buildKeyedState();
    const segments = parsePath(path);

    // Resolve the index-based segments against the effective state
    let current = keyedState;
    for (const seg of segments) {
      if (current === null || current === undefined) return undefined;
      if (isKeyedArray(current)) {
        const idx = Number(seg);
        if (seg === '-' || !Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
        current = current[idx].value;
      } else if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    return unkeyify(current);
  }

  export(): T {
    let result: unknown = deepCopy(this._base);
    for (const op of this._ops.values()) {
      result = applyOp(result, op);
    }
    if (this._copilotSession) {
      for (const op of this._copilotSession._activeOps()) {
        result = applyOp(result, op);
      }
    }
    return unkeyify(result) as T;
  }

  // ─── Propose / Edit ────────────────────────────────────────────────────────

  propose(input: OpInput | OpInput[]): void {
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      parsePath(inp.path); // validate syntax

      // Resolve the index-based path to key-based against current effective keyed state
      const keyedState = this._buildKeyedState();
      const segments = parsePath(inp.path);
      const resolution = resolveToKeyed(segments, keyedState, this._nextKey, inp.kind);
      const keyedSegments = resolution.segments;
      this._nextKey = resolution.counter;
      const keyedPath = keyedSegments.length === 0 ? '' : '/' + keyedSegments.join('/');

      const prev = this._effectiveValue(keyedPath);

      if (inp.kind === 'remove' && prev === undefined) {
        const baseVal = getBySegments(this._base, keyedSegments);
        const userOp = this._ops.get(keyedPath);
        if (baseVal === undefined && !userOp) {
          throw new PathNotFoundError(inp.path);
        }
      }

      // Keyify the value being set (so nested arrays get keys)
      let storedValue = inp.kind === 'remove' ? undefined : inp.value;
      if (storedValue !== undefined) {
        const kv = keyify(storedValue, this._nextKey);
        storedValue = kv.value;
        this._nextKey = kv.counter;
      }

      const op: Op = {
        path: keyedPath,
        kind: inp.kind,
        value: storedValue,
        prev,
        actor: 'user',
        ts: Date.now(),
        insertAt: resolution.insertAt,
      };

      // "User is king" — auto-resolve copilot ops on overlap
      if (this._copilotSession) {
        this._autoResolveCopilotOps(keyedPath);
      }

      this._ops.set(keyedPath, op);
      this._undoStack.push({ kind: 'propose', ops: [op] });
      this._redoStack = [];
      this._bump();
    }
  }

  // ─── Revert ────────────────────────────────────────────────────────────────

  revert(path: string): void {
    const segments = parsePath(path);
    // Resolve to keyed path
    const keyedState = this._buildKeyedState();
    const keyedSegments = resolveToKeyed(segments, keyedState, this._nextKey, 'replace').segments;
    const keyedPath = keyedSegments.length === 0 ? '' : '/' + keyedSegments.join('/');

    const op = this._ops.get(keyedPath);
    if (!op) throw new NoOpAtPathError(path);

    const toRemove: Op[] = [];
    for (const [p, o] of this._ops) {
      if (p === keyedPath || isDescendant(p, keyedPath)) {
        toRemove.push(o);
      }
    }
    for (const o of toRemove) {
      this._ops.delete(o.path);
    }

    this._undoStack.push({ kind: 'revert', ops: [], undone: toRemove });
    this._redoStack = [];
    this._bump();
  }

  // ─── Undo / Redo ──────────────────────────────────────────────────────────

  undo(): void {
    if (this._undoStack.length === 0) return;
    const action = this._undoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      for (const op of action.ops) {
        this._ops.delete(op.path);
      }
      for (const op of action.ops) {
        const earlier = this._findEarlierOp(op.path);
        if (earlier) this._ops.set(op.path, earlier);
      }
    } else if (action.kind === 'revert') {
      if (action.undone) {
        for (const op of action.undone) {
          this._ops.set(op.path, op);
        }
      }
    } else if (action.kind === 'apply') {
      if (action.undone) {
        let base: unknown = deepCopy(this._base);
        for (let i = action.undone.length - 1; i >= 0; i--) {
          const op = action.undone[i];
          base = reverseOp(base, op);
        }
        this._base = base;
        for (const op of action.undone) {
          this._ops.set(op.path, op);
        }
      }
    }

    this._redoStack.push(action);
    this._bump();
  }

  redo(): void {
    if (this._redoStack.length === 0) return;
    const action = this._redoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      for (const op of action.ops) {
        this._ops.set(op.path, op);
      }
    } else if (action.kind === 'revert') {
      if (action.undone) {
        for (const op of action.undone) {
          this._ops.delete(op.path);
        }
      }
    } else if (action.kind === 'apply') {
      if (action.undone) {
        let base: unknown = deepCopy(this._base);
        for (const op of action.undone) {
          base = applyOp(base, op);
          this._ops.delete(op.path);
        }
        this._base = base;
      }
    }

    this._undoStack.push(action);
    this._bump();
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  diff(): Op[] {
    // Translate key-based paths to index-based for the public API
    const keyedState = this._buildKeyedStateFromBase();
    return [...this._ops.values()].map((op) => {
      const { insertAt: _, ...rest } = op;
      return {
        ...rest,
        path: toIndexPath(op.path, keyedState),
        value: op.value !== undefined ? unkeyify(op.value) : undefined,
        prev: op.prev !== undefined ? unkeyify(op.prev) : undefined,
      };
    });
  }

  diffTree(): DiffTreeNode {
    return buildDiffTree(this.diff());
  }

  // ─── Apply ─────────────────────────────────────────────────────────────────

  apply(): void {
    if (this._copilotSession) throw new CopilotSessionOpenError();
    if (this._ops.size === 0) return;

    const applied = [...this._ops.values()];

    let base: unknown = deepCopy(this._base);
    for (const op of applied) {
      base = applyOp(base, op);
    }
    this._base = base;
    this._ops.clear();

    this._undoStack.push({ kind: 'apply', ops: [], undone: applied });
    this._redoStack = [];
    this._bump();
  }

  // ─── Copilot ───────────────────────────────────────────────────────────────

  startCopilot(): CopilotSession {
    if (this._copilotSession) throw new CopilotAlreadyOpenError();
    this._copilotSession = new CopilotSession(this as Engine<unknown>);
    this._bump();
    return this._copilotSession;
  }

  activeCopilotSession(): CopilotSession | null {
    return this._copilotSession;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** @internal */
  _getActiveOp(path: string): Op | undefined {
    return this._ops.get(path);
  }

  /** @internal */
  _activeOps(): Op[] {
    return [...this._ops.values()];
  }

  /** @internal — effective value at a keyed path (base + user ops, no copilot). */
  _effectiveValue(keyedPath: string): unknown {
    const uop = this._ops.get(keyedPath);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getBySegments(this._base, parsePath(keyedPath));
  }

  /** @internal — accept a copilot op into the user layer. */
  _acceptOp(op: Op): void {
    this._ops.set(op.path, op);
    this._undoStack.push({ kind: 'approve', ops: [op] });
    this._redoStack = [];
  }

  /**
   * @internal — build the effective keyed state (base + user ops + copilot ops).
   * Used for resolving index-based paths to key-based paths.
   */
  _buildKeyedState(): unknown {
    let state: unknown = deepCopy(this._base);
    for (const op of this._ops.values()) {
      state = applyOp(state, op);
    }
    if (this._copilotSession) {
      for (const op of this._copilotSession._activeOps()) {
        state = applyOp(state, op);
      }
    }
    return state;
  }

  /**
   * @internal — build keyed state from base + user ops only (no copilot).
   * Used for diff path translation.
   */
  _buildKeyedStateFromBase(): unknown {
    let state: unknown = deepCopy(this._base);
    for (const op of this._ops.values()) {
      state = applyOp(state, op);
    }
    return state;
  }

  /**
   * @internal — resolve an index-based path to keyed, against current effective state.
   */
  _resolveToKeyed(indexPath: string, opKind: 'add' | 'remove' | 'replace'): { keyedPath: string; counter: number } {
    const segments = parsePath(indexPath);
    const keyedState = this._buildKeyedState();
    const result = resolveToKeyed(segments, keyedState, this._nextKey, opKind);
    const keyedPath = result.segments.length === 0 ? '' : '/' + result.segments.join('/');
    return { keyedPath, counter: result.counter };
  }

  private _autoResolveCopilotOps(userPath: string): void {
    if (!this._copilotSession) return;

    const toDecline: string[] = [];
    const toAccept: string[] = [];

    for (const [copPath] of this._copilotSession._ops) {
      if (copPath === userPath) {
        toDecline.push(copPath);
      } else if (isDescendant(userPath, copPath)) {
        toAccept.push(copPath);
      } else if (isAncestor(userPath, copPath)) {
        toDecline.push(copPath);
      }
    }

    for (const path of toAccept) {
      const cop = this._copilotSession._ops.get(path)!;
      this._copilotSession._ops.delete(path);
      this._ops.set(path, cop);
      this._undoStack.push({ kind: 'approve', ops: [cop] });
    }

    for (const path of toDecline) {
      this._copilotSession._ops.delete(path);
    }
  }

  private _findEarlierOp(path: string): Op | undefined {
    for (let i = this._undoStack.length - 1; i >= 0; i--) {
      const action = this._undoStack[i];
      if (action.kind === 'propose' || action.kind === 'approve') {
        for (const op of action.ops) {
          if (op.path === path) return op;
        }
      }
    }
    return undefined;
  }
}

// ─── Op helpers ─────────────────────────────────────────────────────────────

/** Apply a single op (with keyed path) to a keyed object, returning a new keyed object. */
export function applyOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'remove') {
    return removeBySegments(obj, segments);
  }
  return setBySegments(obj, segments, op.value, op.insertAt);
}

/** Reverse a single op using its captured prev value. */
function reverseOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'add') {
    return removeBySegments(obj, segments);
  } else if (op.kind === 'remove') {
    return setBySegments(obj, segments, op.prev);
  } else {
    return setBySegments(obj, segments, op.prev);
  }
}

/** Convert a key-based path to an index-based path for the public API. */
function toIndexPath(keyedPath: string, keyedState: unknown): string {
  const segments = parsePath(keyedPath);
  const indexed = resolveToIndex(segments, keyedState);
  return indexed.length === 0 ? '' : '/' + indexed.join('/');
}

// ─── diffTree builder ───────────────────────────────────────────────────────

function buildDiffTree(ops: (Op | DiffEntry)[]): DiffTreeNode {
  const root: DiffTreeNode = { children: new Map() };
  for (const op of ops) {
    const segments = parsePath(op.path);
    let node = root;
    for (const seg of segments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { segment: seg, children: new Map() });
      }
      node = node.children.get(seg)!;
    }
    node.op = op;
  }
  return root;
}
