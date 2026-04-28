import type { Op, OpInput, Action, DiffEntry, DiffTreeNode } from './types.js';
import { SessionClosedError, NoOpAtPathError } from './errors.js';
import { parsePath, pathsOverlap, unkeyify } from './pointer.js';
import type { Engine } from './engine.js';

/**
 * A thin review interface for copilot-proposed changes.
 *
 * The engine owns the copilot ops and shared editing logic.
 * This session provides the review API (approve/decline per-op)
 * and routes propose/revert/undo/redo to the engine's shared methods.
 */
export class CopilotSession {
  private _engine: Engine;
  private _closed = false;

  /** @internal — owned by the engine, session holds a reference */
  _ops: Map<string, Op>;
  private _undoStack: Action[];
  private _redoStack: Action[];

  /** @internal */
  constructor(
    engine: Engine,
    ops: Map<string, Op>,
    undoStack: Action[],
    redoStack: Action[],
  ) {
    this._engine = engine;
    this._ops = ops;
    this._undoStack = undoStack;
    this._redoStack = redoStack;
  }

  private _assertOpen(): void {
    if (this._closed) throw new SessionClosedError();
  }

  // ─── Editing (delegates to engine shared methods) ──────────────────────────

  propose(input: OpInput | OpInput[]): void {
    this._assertOpen();
    const inputs = Array.isArray(input) ? input : [input];
    for (const inp of inputs) {
      this._engine._proposeOn(this._ops, this._undoStack, this._redoStack, inp, 'copilot');
    }
  }

  move(from: string, to: string): void {
    this._assertOpen();
    this._engine._moveOn(this._ops, this._undoStack, this._redoStack, from, to, 'copilot');
  }

  revert(path: string): void {
    this._assertOpen();
    this._engine._revertOn(this._ops, this._undoStack, this._redoStack, path);
  }

  undo(): void {
    this._assertOpen();
    this._engine._undoOn(this._ops, this._undoStack, this._redoStack);
  }

  redo(): void {
    this._assertOpen();
    this._engine._redoOn(this._ops, this._undoStack, this._redoStack);
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  diff(): DiffEntry[] {
    const state = this._engine._stateWithUserOps();
    const entries: DiffEntry[] = [];

    for (const op of this._ops.values()) {
      const { insertAt: _, ...rest } = op;
      const entry: DiffEntry = {
        ...rest,
        path: this._engine._toExternalPath(op.path, state),
        value: op.value !== undefined ? unkeyify(op.value) : undefined,
        prev: op.prev !== undefined ? unkeyify(op.prev) : undefined,
      };

      for (const userOp of this._engine._activeOps()) {
        if (pathsOverlap(op.path, userOp.path)) {
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

  // ─── Review API ────────────────────────────────────────────────────────────

  approve(path: string): void {
    this._assertOpen();
    const internalPath = this._resolveForLookup(path);
    const op = this._ops.get(internalPath);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(internalPath);
    this._engine._acceptOp(op);
    this._engine._bump();
  }

  decline(path: string): void {
    this._assertOpen();
    const internalPath = this._resolveForLookup(path);
    const op = this._ops.get(internalPath);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(internalPath);
    this._engine._bump();
  }

  approveAll(): void {
    this._assertOpen();
    for (const [path, op] of [...this._ops.entries()]) {
      this._ops.delete(path);
      this._engine._acceptOp(op);
    }
    this._close();
    this._engine._bump();
  }

  declineAll(): void {
    this._assertOpen();
    this._ops.clear();
    this._close();
    this._engine._bump();
  }

  end(): void {
    this._assertOpen();
    this._ops.clear();
    this._close();
    this._engine._bump();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _close(): void {
    this._closed = true;
    this._engine._closeCopilot();
  }

  /** Resolve a caller path for approve/decline lookup. */
  private _resolveForLookup(path: string): string {
    try {
      const { internalPath } = this._engine._resolve(path, 'replace');
      return internalPath;
    } catch {
      return path;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
