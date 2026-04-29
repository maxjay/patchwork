export { Engine } from './engine.js';
export { CopilotSession } from './copilot.js';
export type { Op, OpInput, DiffEntry, DiffTreeNode, NodeInfo, Action, SchemaError } from './types.js';
export {
  PatchworkError,
  CopilotAlreadyOpenError,
  SessionClosedError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  InvalidPathError,
  PathNotFoundError,
  ValidationError,
} from './errors.js';
