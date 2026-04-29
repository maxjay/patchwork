export { Engine } from './engine.js';
export { CopilotSession } from './copilot.js';
export type { Op, OpInput, DiffEntry, DiffTreeNode, NodeInfo, Action, EngineOptions } from './types.js';
export {
  OnionskinError,
  CopilotAlreadyOpenError,
  SessionClosedError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  InvalidPathError,
  PathNotFoundError,
} from './errors.js';
