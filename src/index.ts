export { Engine } from './engine.js';
export { UserSession, CopilotSession } from './session.js';
export type { Op, OpInput, DiffEntry, DiffTreeNode, Action, EngineOptions } from './types.js';
export {
  OnionskinError,
  SessionAlreadyOpenError,
  CopilotAlreadyOpenError,
  SessionClosedError,
  CopilotSessionOpenError,
  NoOpAtPathError,
  InvalidPathError,
  PathNotFoundError,
} from './errors.js';
