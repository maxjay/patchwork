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
};

/** A copilot diff entry — may carry a conflict flag. */
export type DiffEntry = Op & { conflictsWithUser?: boolean };

/** One reversible unit of work on the undo/redo stack. */
export type Action = {
  kind: 'propose' | 'revert' | 'approve';
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
