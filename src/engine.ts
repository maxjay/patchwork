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
  buildPath,
  getBySegments,
  setBySegments,
  removeBySegments,
  isAncestor,
  isDescendant,
  pathsOverlap,
  keyify,
  containsArray,
  unkeyify,
  resolveToInternal,
  resolveToExternal,
} from './pointer.js';
import { CopilotSession } from './copilot.js';
import { deepCopy } from './util.js';

export class Engine<T = unknown> {
  private _base: unknown;
  private _ops: Map<string, Op> = new Map();
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _version = 0;
  private _opts: EngineOptions<T>;
  private _listeners: Set<() => void> = new Set();
  /** @internal */
  _nextKey: number;

  /** @internal */
  _copilotSession: CopilotSession | null = null;
  /** @internal — copilot ops, owned by engine, shared with session */
  _copilotOps: Map<string, Op> | null = null;

  constructor(base: T, opts?: EngineOptions<T>) {
    const result = keyify(deepCopy(base), 0);
    this._base = result.value;
    this._nextKey = result.counter;
    this._opts = opts ?? {};
  }

  get version(): number {
    return this._version;
  }

  /** @internal */
  _bump(): void {
    this._version++;
    for (const fn of this._listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  get(path: string): unknown {
    const state = this._currentState();
    const segments = parsePath(path);

    // Walk the state by index — arrays use positional access
    let current = state;
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

  getBase(path: string): unknown {
    const segments = parsePath(path);
    let current = this._base;
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

  getDiff(path: string): { base: unknown; current: unknown } | null {
    const base = this.getBase(path);
    const current = this.get(path);
    if (base === current) return null;
    return { base, current };
  }

  export(): T {
    return unkeyify(this._currentState()) as T;
  }

  // ─── Propose / Edit ────────────────────────────────────────────────────────

  propose(input: OpInput | OpInput[]): void {
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      if (this._copilotOps) {
        const { internalPath } = this._resolve(inp.path, inp.kind);
        this._autoResolveCopilotOps(internalPath);
      }
      this._proposeOn(this._ops, this._undoStack, this._redoStack, inp, 'user');
    }
  }

  // ─── Move / Rename ──────────────────────────────────────────────────────────

  move(from: string, to: string): void {
    this._moveOn(this._ops, this._undoStack, this._redoStack, from, to, 'user');
  }

  // ─── Revert ────────────────────────────────────────────────────────────────

  revert(path: string): void {
    this._revertOn(this._ops, this._undoStack, this._redoStack, path);
  }

  // ─── Undo / Redo ──────────────────────────────────────────────────────────

  undo(): void {
    this._undoOn(this._ops, this._undoStack, this._redoStack);
  }

  redo(): void {
    this._redoOn(this._ops, this._undoStack, this._redoStack);
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  diff(): Op[] {
    const state = this._stateWithUserOps();
    return [...this._ops.values()].map((op) => {
      const { insertAt: _, ...rest } = op;
      return {
        ...rest,
        path: this._toExternalPath(op.path, state),
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

    let base = this._base;
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
    this._copilotOps = new Map();
    this._copilotSession = new CopilotSession(
      this as Engine<unknown>,
      this._copilotOps,
      [],
      [],
    );
    this._bump();
    return this._copilotSession;
  }

  activeCopilotSession(): CopilotSession | null {
    return this._copilotSession;
  }

  /** @internal — called by CopilotSession._close() */
  _closeCopilot(): void {
    this._copilotSession = null;
    this._copilotOps = null;
  }

  // ─── Shared layer operations ───────────────────────────────────────────────

  /** @internal — propose an op to a given layer (user or copilot). */
  _proposeOn(
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
    input: OpInput,
    actor: 'user' | 'copilot',
  ): void {
    const { internalPath, insertAt } = this._resolve(input.path, input.kind);

    const prev = this._valueAt(internalPath);

    // Removing a path that doesn't exist is a no-op, not an error.
    // Silenced for idempotency — callers shouldn't need to check before removing.
    // throw new PathNotFoundError(input.path);
    if (input.kind === 'remove' && prev === undefined) return;

    let storedValue = input.kind === 'remove' ? undefined : input.value;
    if (storedValue !== undefined && containsArray(storedValue)) {
      const kv = keyify(storedValue, this._nextKey);
      storedValue = kv.value;
      this._nextKey = kv.counter;
    }

    const op: Op = {
      path: internalPath,
      kind: input.kind,
      value: storedValue,
      prev,
      actor,
      ts: Date.now(),
      insertAt,
    };

    ops.set(internalPath, op);
    undoStack.push({ kind: 'propose', ops: [op] });
    redoStack.length = 0;
    this._bump();
  }

  /** @internal — move/rename: remove from source, add at destination, one undo step. */
  _moveOn(
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
    from: string,
    to: string,
    actor: 'user' | 'copilot',
  ): void {
    const { internalPath: fromPath } = this._resolve(from, 'remove');
    const { internalPath: toPath, insertAt } = this._resolve(to, 'add');

    const prev = this._valueAt(fromPath);
    if (prev === undefined) throw new PathNotFoundError(from);

    // Collect the effective value at the source (base + ops, keyed)
    const state = this._currentState();
    const value = getBySegments(state, parsePath(fromPath));

    // Remove descendant ops at source — their values are folded into the moved value
    const removedDescendants: Op[] = [];
    for (const [opPath, pendingOp] of ops) {
      if (isDescendant(opPath, fromPath)) {
        removedDescendants.push(pendingOp);
        ops.delete(opPath);
      }
    }

    const removeOp: Op = {
      path: fromPath, kind: 'remove', prev, actor, ts: Date.now(),
    };
    const addOp: Op = {
      path: toPath, kind: 'add', value, actor, ts: Date.now(), insertAt,
    };

    if (actor === 'user' && this._copilotOps) {
      this._autoResolveCopilotOps(fromPath);
      this._autoResolveCopilotOps(toPath);
    }

    ops.set(fromPath, removeOp);
    ops.set(toPath, addOp);
    undoStack.push({ kind: 'propose', ops: [removeOp, addOp], undone: removedDescendants.length > 0 ? removedDescendants : undefined });
    redoStack.length = 0;
    this._bump();
  }

  /** @internal — revert an op from a given layer. */
  _revertOn(
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
    path: string,
  ): void {
    const { internalPath } = this._resolve(path, 'replace');

    const op = ops.get(internalPath);
    if (!op) throw new NoOpAtPathError(path);

    const toRemove: Op[] = [];
    for (const [opPath, pendingOp] of ops) {
      if (opPath === internalPath || isDescendant(opPath, internalPath)) {
        toRemove.push(pendingOp);
      }
    }
    for (const pendingOp of toRemove) {
      ops.delete(pendingOp.path);
    }

    undoStack.push({ kind: 'revert', ops: [], undone: toRemove });
    redoStack.length = 0;
    this._bump();
  }

  /** @internal — undo the last action on a given layer. */
  _undoOn(
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
  ): void {
    if (undoStack.length === 0) return;
    const action = undoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      for (const op of action.ops) {
        ops.delete(op.path);
      }
      for (const op of action.ops) {
        const earlier = this._findEarlierOpIn(undoStack, op.path);
        if (earlier) ops.set(op.path, earlier);
      }
      // Restore descendant ops removed by move
      if (action.undone) {
        for (const op of action.undone) {
          ops.set(op.path, op);
        }
      }
    } else if (action.kind === 'revert') {
      if (action.undone) {
        for (const op of action.undone) {
          ops.set(op.path, op);
        }
      }
    } else if (action.kind === 'apply') {
      if (action.undone) {
        // Reverse each op against the base to undo the apply
        let base = this._base;
        for (let i = action.undone.length - 1; i >= 0; i--) {
          base = reverseOp(base, action.undone[i]);
        }
        this._base = base;
        // Restore the ops to the active set
        for (const op of action.undone) {
          ops.set(op.path, op);
        }
      }
    }

    redoStack.push(action);
    this._bump();
  }

  /** @internal — redo the last undone action on a given layer. */
  _redoOn(
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
  ): void {
    if (redoStack.length === 0) return;
    const action = redoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      for (const op of action.ops) {
        ops.set(op.path, op);
      }
      // Re-remove descendant ops for move redo
      if (action.undone) {
        for (const op of action.undone) {
          ops.delete(op.path);
        }
      }
    } else if (action.kind === 'revert') {
      if (action.undone) {
        for (const op of action.undone) {
          ops.delete(op.path);
        }
      }
    } else if (action.kind === 'apply') {
      if (action.undone) {
        // Re-apply each op to the base and remove from active set
        let base = this._base;
        for (const op of action.undone) {
          base = applyOp(base, op);
          ops.delete(op.path);
        }
        this._base = base;
      }
    }

    undoStack.push(action);
    this._bump();
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

  /** @internal — value at an internal path (base + user ops, no copilot). */
  _valueAt(internalPath: string): unknown {
    const uop = this._ops.get(internalPath);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getBySegments(this._base, parsePath(internalPath));
  }

  /** @internal — accept a copilot op into the user layer. */
  _acceptOp(op: Op): void {
    this._ops.set(op.path, op);
    this._undoStack.push({ kind: 'approve', ops: [op] });
    this._redoStack = [];
  }

  /**
   * @internal — resolve a caller's index-based path to the internal path.
   * For paths that don't touch arrays, this is a no-op.
   */
  _resolve(
    path: string,
    opKind: 'add' | 'remove' | 'replace',
  ): { internalPath: string; insertAt?: number } {
    parsePath(path); // validate
    const segments = parsePath(path);
    const state = this._currentState();
    const result = resolveToInternal(segments, state, this._nextKey, opKind);
    this._nextKey = result.counter;
    return {
      internalPath: buildPath(result.segments),
      insertAt: result.insertAt,
    };
  }

  /** @internal — convert an internal path back to caller-facing index path. */
  _toExternalPath(internalPath: string, state: unknown): string {
    const segments = parsePath(internalPath);
    return buildPath(resolveToExternal(segments, state));
  }

  /** @internal — current state: base + all ops applied. */
  _currentState(): unknown {
    let state = this._base;
    for (const op of this._ops.values()) {
      state = applyOp(state, op);
    }
    if (this._copilotOps) {
      for (const op of this._copilotOps.values()) {
        state = applyOp(state, op);
      }
    }
    return state;
  }

  /** @internal — base + user ops only (no copilot). For diff translation. */
  _stateWithUserOps(): unknown {
    let state = this._base;
    for (const op of this._ops.values()) {
      state = applyOp(state, op);
    }
    return state;
  }

  private _autoResolveCopilotOps(userPath: string): void {
    if (!this._copilotOps) return;

    const toDecline: string[] = [];
    const toAccept: string[] = [];

    for (const [copPath] of this._copilotOps) {
      if (copPath === userPath) {
        // User is editing the same path copilot proposed on — accept the copilot
        // op first so the user's edit layers on top with correct prev.
        toAccept.push(copPath);
      } else if (isDescendant(userPath, copPath)) {
        toAccept.push(copPath);
      } else if (isAncestor(userPath, copPath)) {
        toDecline.push(copPath);
      }
    }

    for (const path of toAccept) {
      const cop = this._copilotOps.get(path)!;
      this._copilotOps.delete(path);
      this._ops.set(path, cop);
      this._undoStack.push({ kind: 'approve', ops: [cop] });
    }

    for (const path of toDecline) {
      this._copilotOps.delete(path);
    }
  }

  private _findEarlierOpIn(undoStack: Action[], path: string): Op | undefined {
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const action = undoStack[i];
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

export function applyOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'remove') return removeBySegments(obj, segments);
  return setBySegments(obj, segments, op.value, op.insertAt);
}

function reverseOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'add') return removeBySegments(obj, segments);
  return setBySegments(obj, segments, op.prev);
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
