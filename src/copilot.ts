import type { Op, OpInput, Action, DiffEntry, DiffTreeNode } from './types.js';
import { SessionClosedError, NoOpAtPathError, PathNotFoundError } from './errors.js';
import {
  parsePath,
  isDescendant,
  pathsOverlap,
  resolveToKeyed,
  resolveToIndex,
  keyify,
  unkeyify,
  getBySegments,
} from './pointer.js';
import type { Engine } from './engine.js';

export class CopilotSession {
  private _engine: Engine;
  /** @internal */
  _ops: Map<string, Op> = new Map();
  private _undoStack: Action[] = [];
  private _redoStack: Action[] = [];
  private _closed = false;

  constructor(engine: Engine) {
    this._engine = engine;
  }

  private _assertOpen(): void {
    if (this._closed) throw new SessionClosedError();
  }

  /** @internal */
  _getActiveOp(path: string): Op | undefined {
    return this._ops.get(path);
  }

  /** @internal */
  _activeOps(): Op[] {
    return [...this._ops.values()];
  }

  propose(input: OpInput | OpInput[]): void {
    this._assertOpen();
    const inputs = Array.isArray(input) ? input : [input];

    for (const inp of inputs) {
      parsePath(inp.path); // validate syntax

      // Resolve index-based path to key-based
      const keyedState = this._engine._buildKeyedState();
      const segments = parsePath(inp.path);
      const resolution = resolveToKeyed(segments, keyedState, this._engine._nextKey, inp.kind);
      const keyedSegments = resolution.segments;
      this._engine._nextKey = resolution.counter;
      const keyedPath = keyedSegments.length === 0 ? '' : '/' + keyedSegments.join('/');

      const prev = this._engine._effectiveValue(keyedPath);

      if (inp.kind === 'remove' && prev === undefined) {
        throw new PathNotFoundError(inp.path);
      }

      // Keyify the value
      let storedValue = inp.kind === 'remove' ? undefined : inp.value;
      if (storedValue !== undefined) {
        const kv = keyify(storedValue, this._engine._nextKey);
        storedValue = kv.value;
        this._engine._nextKey = kv.counter;
      }

      const op: Op = {
        path: keyedPath,
        kind: inp.kind,
        value: storedValue,
        prev,
        actor: 'copilot',
        ts: Date.now(),
        insertAt: resolution.insertAt,
      };

      this._ops.set(keyedPath, op);
      this._undoStack.push({ kind: 'propose', ops: [op] });
      this._redoStack = [];
      this._engine._bump();
    }
  }

  revert(path: string): void {
    this._assertOpen();
    // Resolve to keyed path
    const keyedState = this._engine._buildKeyedState();
    const segments = parsePath(path);
    const keyedSegments = resolveToKeyed(segments, keyedState, this._engine._nextKey, 'replace').segments;
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
    // Build keyed state for path translation
    const keyedState = this._engine._buildKeyedStateFromBase();
    const entries: DiffEntry[] = [];
    for (const op of this._ops.values()) {
      const indexPath = toIndexPath(op.path, keyedState);
      const { insertAt: _, ...rest } = op;
      const entry: DiffEntry = {
        ...rest,
        path: indexPath,
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

  approve(path: string): void {
    this._assertOpen();
    // Resolve to keyed path
    const keyedPath = this._resolveInputPath(path);

    const op = this._ops.get(keyedPath);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(keyedPath);
    this._engine._acceptOp(op);
    this._engine._bump();
  }

  decline(path: string): void {
    this._assertOpen();
    const keyedPath = this._resolveInputPath(path);

    const op = this._ops.get(keyedPath);
    if (!op) throw new NoOpAtPathError(path);

    this._ops.delete(keyedPath);
    this._engine._bump();
  }

  approveAll(): void {
    this._assertOpen();
    for (const path of [...this._ops.keys()]) {
      const op = this._ops.get(path)!;
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

  private _close(): void {
    this._closed = true;
    this._engine._copilotSession = null;
  }

  /**
   * Resolve an index-based input path to the keyed path.
   * For approve/decline, the path must match an existing copilot op.
   */
  private _resolveInputPath(path: string): string {
    const keyedState = this._engine._buildKeyedState();
    const segments = parsePath(path);
    try {
      const keyedSegments = resolveToKeyed(segments, keyedState, this._engine._nextKey, 'replace').segments;
      return keyedSegments.length === 0 ? '' : '/' + keyedSegments.join('/');
    } catch {
      // If resolution fails, the path might not exist in current state.
      // Return the raw path and let the caller handle NoOpAtPathError.
      return path;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toIndexPath(keyedPath: string, keyedState: unknown): string {
  const segments = parsePath(keyedPath);
  const indexed = resolveToIndex(segments, keyedState);
  return indexed.length === 0 ? '' : '/' + indexed.join('/');
}

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
