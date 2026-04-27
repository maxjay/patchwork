import type { Op, OpInput, Action, DiffEntry, DiffTreeNode, EngineOptions } from './types.js';
import {
  CopilotAlreadyOpenError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  PathNotFoundError,
} from './errors.js';
import {
  parsePath,
  getByPath,
  setBySegments,
  removeBySegments,
  isAncestor,
  isDescendant,
  pathsOverlap,
} from './pointer.js';
import { CopilotSession } from './copilot.js';
import { deepCopy } from './util.js';

export class Engine<T = unknown> {
  private _base: T;
  private _ops: Map<string, Op> = new Map();
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _version = 0;
  private _opts: EngineOptions<T>;

  /** @internal */
  _copilotSession: CopilotSession | null = null;

  constructor(base: T, opts?: EngineOptions<T>) {
    this._base = deepCopy(base);
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
  _getBase(): T {
    return this._base;
  }

  /** @internal */
  _setBase(next: T): void {
    this._base = next;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  get(path: string): unknown {
    // Walk layers top-down: copilot → user ops → base
    if (this._copilotSession) {
      const cop = this._copilotSession._getActiveOp(path);
      if (cop) return cop.kind === 'remove' ? undefined : cop.value;
    }
    const uop = this._ops.get(path);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getByPath(this._base, path);
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
    return result as T;
  }

  // ─── Propose / Edit ────────────────────────────────────────────────────────

  propose(input: OpInput | OpInput[]): void {
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      parsePath(inp.path); // validate

      const prev = this._effectiveValue(inp.path);

      if (inp.kind === 'remove' && prev === undefined) {
        const baseVal = getByPath(this._base, inp.path);
        const userOp = this._ops.get(inp.path);
        if (baseVal === undefined && !userOp) {
          throw new PathNotFoundError(inp.path);
        }
      }

      const op: Op = {
        path: inp.path,
        kind: inp.kind,
        value: inp.kind === 'remove' ? undefined : inp.value,
        prev,
        actor: 'user',
        ts: Date.now(),
      };

      // "User is king" — auto-resolve copilot ops on overlap
      if (this._copilotSession) {
        this._autoResolveCopilotOps(inp.path);
      }

      this._ops.set(inp.path, op);
      this._undoStack.push({ kind: 'propose', ops: [op] });
      this._redoStack = [];
      this._bump();
    }
  }

  // ─── Revert ────────────────────────────────────────────────────────────────

  revert(path: string): void {
    parsePath(path);
    const op = this._ops.get(path);
    if (!op) throw new NoOpAtPathError(path);

    const toRemove: Op[] = [];
    for (const [p, o] of this._ops) {
      if (p === path || isDescendant(p, path)) {
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
      // Undo an apply: restore the ops back into the active set,
      // and revert the base to before the apply.
      if (action.undone) {
        // Reverse-apply each op against the base to restore it
        let base: unknown = deepCopy(this._base);
        for (let i = action.undone.length - 1; i >= 0; i--) {
          const op = action.undone[i];
          base = reverseOp(base, op);
        }
        this._base = base as T;
        // Put the ops back into the active set
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
      // Redo an apply: fold the ops back into the base and clear them
      if (action.undone) {
        let base: unknown = deepCopy(this._base);
        for (const op of action.undone) {
          base = applyOp(base, op);
          this._ops.delete(op.path);
        }
        this._base = base as T;
      }
    }

    this._undoStack.push(action);
    this._bump();
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  diff(): Op[] {
    return [...this._ops.values()];
  }

  diffTree(): DiffTreeNode {
    return buildDiffTree(this.diff());
  }

  // ─── Apply ─────────────────────────────────────────────────────────────────

  /**
   * Fold current ops into the base. The diff resets, but the undo stack
   * survives — you can keep undoing after apply.
   */
  apply(): void {
    if (this._copilotSession) throw new CopilotSessionOpenError();
    if (this._ops.size === 0) return;

    const applied = [...this._ops.values()];

    let base: unknown = deepCopy(this._base);
    for (const op of applied) {
      base = applyOp(base, op);
    }
    this._base = base as T;
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

  /** @internal — effective value at a path (base + user ops, no copilot). */
  _effectiveValue(path: string): unknown {
    const uop = this._ops.get(path);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getByPath(this._base, path);
  }

  /** @internal — accept a copilot op into the user layer. */
  _acceptOp(op: Op): void {
    this._ops.set(op.path, op);
    this._undoStack.push({ kind: 'approve', ops: [op] });
    this._redoStack = [];
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

/** Apply a single op to a plain JSON value, returning a new value. */
export function applyOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'remove') {
    return removeBySegments(obj, segments);
  }
  return setBySegments(obj, segments, op.value);
}

/** Reverse a single op using its captured prev value. */
function reverseOp(obj: unknown, op: Op): unknown {
  const segments = parsePath(op.path);
  if (op.kind === 'add') {
    // Reverse of add is remove
    return removeBySegments(obj, segments);
  } else if (op.kind === 'remove') {
    // Reverse of remove is add (restore prev)
    return setBySegments(obj, segments, op.prev);
  } else {
    // Reverse of replace is replace with prev
    return setBySegments(obj, segments, op.prev);
  }
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
