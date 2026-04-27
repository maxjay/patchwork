/** A keyed array element — stable identity for array items. */
export type KeyedElement = { key: string; value: unknown };

/** Symbol tag used to mark arrays as keyed (including empty ones). */
export const KEYED = Symbol.for('onionskin.keyed');

/** A keyed array is a regular array of KeyedElement, tagged with KEYED. */
export type KeyedArray = KeyedElement[] & { [KEYED]: true };

/** Create a keyed array (tagged). */
export function toKeyed(arr: KeyedElement[]): KeyedArray {
  const a = arr as KeyedArray;
  a[KEYED] = true;
  return a;
}

/** Type guard for keyed arrays. */
export function isKeyedArray(v: unknown): v is KeyedArray {
  return Array.isArray(v) && (v as any)[KEYED] === true;
}

/** What the caller provides to propose(). */
export type OpInput = {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  value?: unknown;
};

/** A fully-resolved operation stored by the engine. */
export type Op = {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  value?: unknown;
  prev?: unknown;
  actor: 'user' | 'copilot';
  ts: number;
  /** @internal — for array inserts, the position to insert at. */
  insertAt?: number;
};

/** A copilot diff entry — may carry a conflict flag. */
export type DiffEntry = Op & { conflictsWithUser?: boolean };

/** One reversible unit of work on the undo/redo stack. */
export type Action = {
  kind: 'propose' | 'revert' | 'approve' | 'apply';
  ops: Op[];
  /** For revert/undo: the ops that were removed, for restoring on undo. */
  undone?: Op[];
};

/** A node in the tree-structured diff view. */
export type DiffTreeNode = {
  segment?: string;
  op?: Op | DiffEntry;
  children: Map<string, DiffTreeNode>;
};

export type EngineOptions<T> = {
  validate?: (next: T) => void;
};
