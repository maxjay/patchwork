export { Engine, NodeEngine, OpType } from './engine.js';
export type { DiffOp, Operation } from './engine.js';
export type { JsonValue } from 'jsonpath-rfc9535';
export { toJsonPatch, diffPatch, applyJsonPatch, jsonPathToPointer, JsonPatchError } from './jsonpatch.js';
export type { JsonPatchOperation, JsonPatchDocument } from './jsonpatch.js';
