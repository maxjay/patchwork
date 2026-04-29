import type { Op, OpInput, Action, DiffEntry, DiffTreeNode, NodeInfo, EngineOptions } from './types.js';
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
} from './pointer.js';
import { CopilotSession } from './copilot.js';
import { deepCopy, deepEqual } from './util.js';

export class Engine<T = unknown> {
  private _base: unknown;
  private _ops: Map<string, Op> = new Map();
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _version = 0;
  private _opts: EngineOptions<T>;
  private _listeners: Set<() => void> = new Set();

  /** @internal */
  _copilotSession: CopilotSession | null = null;
  /** @internal — copilot ops, owned by engine, shared with session */
  _copilotOps: Map<string, Op> | null = null;

  constructor(base: T, opts?: EngineOptions<T>) {
    this._base = deepCopy(base);
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
    const segments = parsePath(path);
    return deepCopy(getBySegments(this._currentState(), segments));
  }

  getBase(path: string): unknown {
    const segments = parsePath(path);
    return deepCopy(getBySegments(this._base, segments));
  }

  getDiff(path: string): { base: unknown; current: unknown } | null {
    const base = this.getBase(path);
    const current = this.get(path);
    if (deepEqual(base, current)) return null;
    return { base, current };
  }

  node(path: string): NodeInfo | null {
    const segments = parsePath(path);
    const state = this._currentState();
    const value = getBySegments(state, segments);

    if (value === undefined) return null;

    const key = segments.length > 0 ? segments[segments.length - 1] : '';
    const baseValue = getBySegments(this._base, segments);

    if (value === null) {
      return { type: 'null', path, key, value: null, base: deepCopy(baseValue), changed: !deepEqual(null, baseValue) };
    }

    if (Array.isArray(value)) {
      const keys = value.map((_, i) => String(i));
      const baseKeys = Array.isArray(baseValue) ? baseValue.map((_, i) => String(i)) : null;
      return { type: 'array', path, key, keys, changed: !deepEqual(keys, baseKeys) };
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>);
      const baseKeys = (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue))
        ? Object.keys(baseValue as Record<string, unknown>)
        : null;
      return { type: 'object', path, key, keys, changed: !deepEqual(keys, baseKeys) };
    }

    return {
      type: typeof value as 'string' | 'number' | 'boolean',
      path,
      key,
      value: deepCopy(value),
      base: deepCopy(baseValue),
      changed: !deepEqual(value, baseValue),
    };
  }

  export(): T {
    return deepCopy(this._currentState()) as T;
  }

  // ─── Propose / Edit ────────────────────────────────────────────────────────

  propose(input: OpInput | OpInput[]): void {
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      if (this._copilotOps) {
        this._autoResolveCopilotOps(inp.path);
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

  // ─── Reset ──────────────────────────────────────────────────────────────────

  /**
   * Reset a path back to its base value, regardless of op structure.
   *
   * Unlike `revert` (which removes the op at a path), `reset` guarantees
   * `get(path) === getBase(path)` after the call — even when the current value
   * comes from an ancestor op rather than an op at the path itself.
   *
   * The entire reset is one undo step.
   */
  reset(path: string): void {
    const baseVal = this.getBase(path);
    const currentVal = this.get(path);
    if (deepEqual(baseVal, currentVal)) return;

    parsePath(path); // validate

    // Step 1: Remove all user ops at path + descendants
    const removedOps: Op[] = [];
    for (const [opPath, op] of this._ops) {
      if (opPath === path || isDescendant(opPath, path)) {
        removedOps.push(op);
      }
    }
    for (const op of removedOps) {
      this._ops.delete(op.path);
    }

    // Step 2: Check if value now matches base (it might not if an ancestor op affects it)
    const stateAfterRemoval = this._stateWithUserOps();
    const valueAfterRemoval = getBySegments(stateAfterRemoval, parsePath(path));
    const baseValueInternal = getBySegments(this._base, parsePath(path));
    const compensatingOps: Op[] = [];

    if (!deepEqual(valueAfterRemoval, baseValueInternal)) {
      if (baseValueInternal === undefined) {
        // Base doesn't have this path — remove it
        const op: Op = {
          path,
          kind: 'remove',
          prev: valueAfterRemoval,
          actor: 'user',
          ts: Date.now(),
        };
        this._ops.set(path, op);
        compensatingOps.push(op);
      } else {
        // Base has this path — replace to match base value
        const op: Op = {
          path,
          kind: 'replace',
          value: deepCopy(baseValueInternal),
          prev: valueAfterRemoval,
          actor: 'user',
          ts: Date.now(),
        };
        this._ops.set(path, op);
        compensatingOps.push(op);
      }
    }

    this._undoStack.push({
      kind: 'reset',
      ops: compensatingOps,
      undone: removedOps.length > 0 ? removedOps : undefined,
    });
    this._redoStack = [];
    this._bump();
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
    return [...this._ops.values()].map((op) => {
      const { insertAt: _, ...rest } = op;
      return {
        ...rest,
        value: op.value !== undefined ? deepCopy(op.value) : undefined,
        prev: op.prev !== undefined ? deepCopy(op.prev) : undefined,
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
    parsePath(input.path); // validate
    const { path, insertAt } = this._resolvePath(input.path, input.kind);

    const prev = this._valueAt(path);

    // Removing a path that doesn't exist is a no-op, not an error.
    if (input.kind === 'remove' && prev === undefined) return;

    const op: Op = {
      path,
      kind: input.kind,
      value: input.kind === 'remove' ? undefined : deepCopy(input.value),
      prev,
      actor,
      ts: Date.now(),
      insertAt,
    };

    ops.set(path, op);
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
    parsePath(from); // validate
    parsePath(to);

    const prev = this._valueAt(from);
    if (prev === undefined) throw new PathNotFoundError(from);

    // Collect the effective value at the source (base + ops)
    const state = this._currentState();
    const value = getBySegments(state, parsePath(from));

    // Remove descendant ops at source — their values are folded into the moved value
    const removedDescendants: Op[] = [];
    for (const [opPath, pendingOp] of ops) {
      if (isDescendant(opPath, from)) {
        removedDescendants.push(pendingOp);
        ops.delete(opPath);
      }
    }

    const { insertAt } = this._resolvePath(to, 'add');

    const removeOp: Op = {
      path: from, kind: 'remove', prev, actor, ts: Date.now(),
    };
    const addOp: Op = {
      path: to, kind: 'add', value, actor, ts: Date.now(), insertAt,
    };

    if (actor === 'user' && this._copilotOps) {
      this._autoResolveCopilotOps(from);
      this._autoResolveCopilotOps(to);
    }

    ops.set(from, removeOp);
    ops.set(to, addOp);
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
    parsePath(path); // validate

    const op = ops.get(path);
    if (!op) throw new NoOpAtPathError(path);

    const toRemove: Op[] = [];
    for (const [opPath, pendingOp] of ops) {
      if (opPath === path || isDescendant(opPath, path)) {
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

    if (action.kind === 'propose' || action.kind === 'approve' || action.kind === 'reset') {
      for (const op of action.ops) {
        ops.delete(op.path);
      }
      for (const op of action.ops) {
        const earlier = this._findEarlierOpIn(undoStack, op.path);
        if (earlier) ops.set(op.path, earlier);
      }
      // Restore ops removed by move or reset
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
        let base = this._base;
        for (let i = action.undone.length - 1; i >= 0; i--) {
          base = reverseOp(base, action.undone[i]);
        }
        this._base = base;
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

    if (action.kind === 'propose' || action.kind === 'approve' || action.kind === 'reset') {
      for (const op of action.ops) {
        ops.set(op.path, op);
      }
      // Re-remove ops for move/reset redo
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

  /** @internal — value at a path (base + user ops, no copilot). */
  _valueAt(path: string): unknown {
    const uop = this._ops.get(path);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getBySegments(this._base, parsePath(path));
  }

  /** @internal — accept a copilot op into the user layer. */
  _acceptOp(op: Op): void {
    this._ops.set(op.path, op);
    this._undoStack.push({ kind: 'approve', ops: [op] });
    this._redoStack = [];
  }

  /**
   * @internal — resolve a path, handling array append (`-`).
   * For non-array paths this is a no-op.
   */
  _resolvePath(
    path: string,
    opKind: 'add' | 'remove' | 'replace',
  ): { path: string; insertAt?: number } {
    if (opKind !== 'add') return { path };

    const segments = parsePath(path);
    if (segments.length === 0) return { path };

    const last = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);
    const state = this._currentState();
    const parent = getBySegments(state, parentSegments);

    if (Array.isArray(parent)) {
      if (last === '-') {
        const resolved = [...parentSegments, String(parent.length)];
        return { path: buildPath(resolved), insertAt: parent.length };
      }
      const idx = Number(last);
      if (Number.isInteger(idx)) {
        return { path, insertAt: idx };
      }
    }

    return { path };
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

  /** @internal — base + user ops only (no copilot). */
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
      if (action.kind === 'propose' || action.kind === 'approve' || action.kind === 'reset') {
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
