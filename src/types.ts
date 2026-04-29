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
  kind: 'propose' | 'revert' | 'approve' | 'apply' | 'reset';
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

/** Metadata about a node at a path in the document. */
export type NodeInfo = {
  path: string;
  key: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  changed: boolean;
  /** Present for object/array — child keys (no subtree values fetched). */
  keys?: string[];
  /** Present for leaves — current effective value. */
  value?: unknown;
  /** Present for leaves — base value (undefined if field was added). */
  base?: unknown;
};

export type EngineOptions<T> = {
  validate?: (next: T) => void;
};
