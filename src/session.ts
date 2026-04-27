import type { Op, OpInput, Action, DiffEntry, DiffTreeNode } from './types.js';
import {
  SessionClosedError,
  CopilotAlreadyOpenError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  PathNotFoundError,
  InvalidPathError,
} from './errors.js';
import { parsePath, getByPath, isAncestor, isDescendant, pathsOverlap } from './pointer.js';
import { applyOp } from './engine.js';
import { deepCopy } from './util.js';
import type { Engine } from './engine.js';

// ─── UserSession ────────────────────────────────────────────────────────────

export class UserSession {
  private _engine: Engine;
  private _ops: Map<string, Op> = new Map(); // path → active op
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _closed = false;
  /** @internal */
  _copilotSession: CopilotSession | null = null;

  constructor(engine: Engine) {
    this._engine = engine;
  }

  private _assertOpen(): void {
    if (this._closed) throw new SessionClosedError();
  }

  /** Get the active op at a path, if any. */
  _getActiveOp(path: string): Op | undefined {
    return this._ops.get(path);
  }

  /** Return active ops in insertion order. Map preserves insertion order. */
  _activeOps(): Op[] {
    return [...this._ops.values()];
  }

  /**
   * Compute the effective value at a path as seen from the user layer
   * (base + user ops, no copilot).
   */
  _effectiveValue(path: string): unknown {
    const uop = this._ops.get(path);
    if (uop) return uop.kind === 'remove' ? undefined : uop.value;
    return getByPath(this._engine._getBase(), path);
  }

  /**
   * Compute the full effective state of base + user ops.
   * Used by CopilotSession to determine prev values.
   */
  _effectiveState(): unknown {
    let result: unknown = deepCopy(this._engine._getBase());
    for (const op of this._ops.values()) {
      result = applyOp(result, op);
    }
    return result;
  }

  propose(input: OpInput | OpInput[]): void {
    this._assertOpen();
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      parsePath(inp.path); // validate

      // Capture prev value from the layer below (base)
      const prev = this._effectiveValue(inp.path);

      // For remove, verify the path exists somewhere (base or user layer)
      if (inp.kind === 'remove' && prev === undefined) {
        // Check if the path actually exists as undefined vs not existing
        const baseVal = getByPath(this._engine._getBase(), inp.path);
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
      this._engine._bump();
    }
  }

  /**
   * Auto-resolve copilot ops when the user edits during a copilot session.
   * Per spec §3.7 "user is king" rules.
   */
  private _autoResolveCopilotOps(userPath: string): void {
    if (!this._copilotSession) return;

    const toDecline: string[] = [];
    const toAccept: string[] = [];

    for (const [copPath] of this._copilotSession._ops) {
      if (copPath === userPath) {
        // Same path → auto-decline
        toDecline.push(copPath);
      } else if (isDescendant(userPath, copPath)) {
        // User edits a descendant of copilot's op → auto-accept copilot op
        toAccept.push(copPath);
      } else if (isAncestor(userPath, copPath)) {
        // User edits an ancestor of copilot's op → auto-decline (cascade)
        toDecline.push(copPath);
      }
      // Unrelated: no action
    }

    // Process auto-accepts first (fold copilot op into user layer)
    for (const path of toAccept) {
      const cop = this._copilotSession._ops.get(path)!;
      this._copilotSession._ops.delete(path);
      // Add to user layer with original actor preserved
      this._ops.set(path, cop);
      this._undoStack.push({ kind: 'approve', ops: [cop] });
      // Don't clear redo — the user's propose will do that
    }

    // Process auto-declines (just remove from copilot layer)
    for (const path of toDecline) {
      this._copilotSession._ops.delete(path);
    }
  }

  revert(path: string): void {
    this._assertOpen();
    parsePath(path); // validate

    const op = this._ops.get(path);
    if (!op) throw new NoOpAtPathError(path);

    // Collect this op + all descendant ops (cascading revert)
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
    this._engine._bump();
  }

  undo(): void {
    this._assertOpen();
    if (this._undoStack.length === 0) return; // no-op on empty stack

    const action = this._undoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      // Remove the ops that were proposed/approved
      for (const op of action.ops) {
        this._ops.delete(op.path);
      }
      // Restore any shadowed op that might have been there before
      // We need to look through the undo stack for earlier ops at the same path
      for (const op of action.ops) {
        const earlier = this._findEarlierOp(op.path);
        if (earlier) {
          this._ops.set(op.path, earlier);
        }
      }
    } else if (action.kind === 'revert') {
      // Restore all the ops that were removed by the revert
      if (action.undone) {
        for (const op of action.undone) {
          this._ops.set(op.path, op);
        }
      }
    }

    this._redoStack.push(action);
    this._engine._bump();
  }

  redo(): void {
    this._assertOpen();
    if (this._redoStack.length === 0) return;

    const action = this._redoStack.pop()!;

    if (action.kind === 'propose' || action.kind === 'approve') {
      // Re-apply the ops
      for (const op of action.ops) {
        this._ops.set(op.path, op);
      }
    } else if (action.kind === 'revert') {
      // Re-remove the ops that were reverted
      if (action.undone) {
        for (const op of action.undone) {
          this._ops.delete(op.path);
        }
      }
    }

    this._undoStack.push(action);
    this._engine._bump();
  }

  /**
   * Find the most recent earlier op at a given path by scanning the undo stack.
   * Used to "uncover" a shadowed op on undo.
   */
  private _findEarlierOp(path: string): Op | undefined {
    // Walk the undo stack backward to find the most recent propose at this path
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

  diff(): Op[] {
    return [...this._ops.values()];
  }

  diffTree(): DiffTreeNode {
    return buildDiffTree(this.diff());
  }

  startCopilot(): CopilotSession {
    this._assertOpen();
    if (this._copilotSession) throw new CopilotAlreadyOpenError();
    this._copilotSession = new CopilotSession(this._engine, this);
    this._engine._bump();
    return this._copilotSession;
  }

  activeCopilotSession(): CopilotSession | null {
    return this._copilotSession;
  }

  commit(): void {
    this._assertOpen();
    if (this._copilotSession) throw new CopilotSessionOpenError();

    // Fold all user ops into the base
    let result: unknown = deepCopy(this._engine._getBase());
    for (const op of this._ops.values()) {
      result = applyOp(result, op);
    }
    this._engine._setBase(result as any);
    this._closed = true;
    this._engine._clearUserSession();
    this._engine._bump();
  }

  discard(): void {
    this._assertOpen();
    this._closed = true;
    this._engine._clearUserSession();
    this._engine._bump();
  }
}

// ─── CopilotSession ────────────────────────────────────────────────────────

export class CopilotSession {
  private _engine: Engine;
  private _userSession: UserSession;
  /** @internal */
  _ops: Map<string, Op> = new Map();
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _closed = false;

  constructor(engine: Engine, userSession: UserSession) {
    this._engine = engine;
    this._userSession = userSession;
  }

  private _assertOpen(): void {
    if (this._closed) throw new SessionClosedError();
  }

  /** Get the active op at a path, if any. */
  _getActiveOp(path: string): Op | undefined {
    return this._ops.get(path);
  }

  /** Return active ops in insertion order. */
  _activeOps(): Op[] {
    return [...this._ops.values()];
  }

  propose(input: OpInput | OpInput[]): void {
    this._assertOpen();
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      parsePath(inp.path); // validate

      // Prev value comes from the user layer (base + user ops)
      const prev = this._userSession._effectiveValue(inp.path);

      if (inp.kind === 'remove' && prev === undefined) {
        throw new PathNotFoundError(inp.path);
      }

      const op: Op = {
        path: inp.path,
        kind: inp.kind,
        value: inp.kind === 'remove' ? undefined : inp.value,
        prev,
        actor: 'copilot',
        ts: Date.now(),
      };

      this._ops.set(inp.path, op);
      this._undoStack.push({ kind: 'propose', ops: [op] });
      this._redoStack = [];
      this._engine._bump();
    }
  }

  revert(path: string): void {
    this._assertOpen();
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
    this._engine._bump();
  }

  undo(): void {
    this._assertOpen();
    if (this._undoStack.length === 0) return;

    const action = this._undoStack.pop()!;

    if (action.kind === 'propose') {
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
    }

    this._redoStack.push(action);
    this._engine._bump();
  }

  redo(): void {
    this._assertOpen();
    if (this._redoStack.length === 0) return;

    const action = this._redoStack.pop()!;

    if (action.kind === 'propose') {
      for (const op of action.ops) {
        this._ops.set(op.path, op);
      }
    } else if (action.kind === 'revert') {
      if (action.undone) {
        for (const op of action.undone) {
          this._ops.delete(op.path);
        }
      }
    }

    this._undoStack.push(action);
    this._engine._bump();
  }

  private _findEarlierOp(path: string): Op | undefined {
    for (let i = this._undoStack.length - 1; i >= 0; i--) {
      const action = this._undoStack[i];
      if (action.kind === 'propose') {
        for (const op of action.ops) {
          if (op.path === path) return op;
        }
      }
    }
    return undefined;
  }

  diff(): DiffEntry[] {
    const entries: DiffEntry[] = [];
    for (const op of this._ops.values()) {
      const entry: DiffEntry = { ...op };
      // Check if user has already touched an overlapping path
      for (const [userPath] of this._userSession._activeOps().map((o) => [o.path] as const)) {
        if (pathsOverlap(op.path, userPath)) {
          entry.conflictsWithUser = true;
          break;
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  diffTree(): DiffTreeNode {
    return buildDiffTree(this.diff());
  }

  approve(path: string): void {
    this._assertOpen();
    const op = this._ops.get(path);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(path);
    // Fold into user layer — actor stays 'copilot' per spec
    this._userSession._getActiveOp(path); // (no-op, just checking)
    (this._userSession as any)._ops.set(path, op);
    (this._userSession as any)._undoStack.push({ kind: 'approve', ops: [op] });
    (this._userSession as any)._redoStack = [];
    this._engine._bump();
  }

  decline(path: string): void {
    this._assertOpen();
    const op = this._ops.get(path);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(path);
    this._engine._bump();
  }

  approveAll(): void {
    this._assertOpen();
    for (const path of [...this._ops.keys()]) {
      this.approve(path);
    }
    this._close();
  }

  declineAll(): void {
    this._assertOpen();
    this._ops.clear();
    this._close();
    this._engine._bump();
  }

  end(): void {
    this._assertOpen();
    // Unresolved ops are dropped
    this._ops.clear();
    this._close();
    this._engine._bump();
  }

  private _close(): void {
    this._closed = true;
    this._userSession._copilotSession = null;
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
