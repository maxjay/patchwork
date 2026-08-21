import type { JsonValue } from 'jsonpath-rfc9535';
import { OpType, jsonPathToSegments, type DiffOp } from './engine.js';

// RFC 6902 JSON Patch — the six standard operations. Unlike DiffOp (which is
// JSONPath-addressed and carries engine-specific metadata like `identity` or
// `displacement`), a JsonPatchOperation is addressed by JSON Pointer (RFC 6901)
// and carries only what the spec defines.
export type JsonPatchOperation =
	| { op: 'add';     path: string; value: JsonValue }
	| { op: 'remove';  path: string }
	| { op: 'replace'; path: string; value: JsonValue }
	| { op: 'move';    path: string; from: string }
	| { op: 'copy';    path: string; from: string }
	| { op: 'test';    path: string; value: JsonValue };

export type JsonPatchDocument = JsonPatchOperation[];

// Thrown by applyJsonPatch. Carries the index of the failing operation (its
// position in the patch document) and the operation itself, so callers can
// report exactly what failed without re-deriving it from the error message.
export class JsonPatchError extends Error {
	constructor(
		message: string,
		public readonly index: number,
		public readonly operation: JsonPatchOperation,
	) {
		super(`operation ${index} (${(operation as { op: string }).op} ${'path' in operation ? operation.path : ''}) failed: ${message}`);
		this.name = 'JsonPatchError';
	}
}

// --- JSONPath (normalized) -> JSON Pointer (RFC 6901) ---------------------

function escapePointerToken(segment: string | number): string {
	if (typeof segment === 'number') return String(segment);
	return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Converts a normalized JSONPath (as produced by Engine, e.g. $['a']['b'][0])
// into an RFC 6901 JSON Pointer (e.g. /a/b/0). The root path ($) maps to the
// empty string, per spec.
export function jsonPathToPointer(jsonPath: string): string {
	return jsonPathToSegments(jsonPath)
		.map(segment => '/' + escapePointerToken(segment))
		.join('');
}

// --- diff() output -> RFC 6902 patch document ------------------------------

// Flattens an element-level Replace op (identity-keyed array diffing) into
// its field-level `changes`, when present — this yields a minimal patch
// instead of one op that replaces the whole element wholesale. Falls back to
// a single whole-value replace when there are no field-level changes to
// flatten (e.g. plain value replaces have no `changes`).
function fromReplace(op: Extract<DiffOp, { op: OpType.Replace }>): JsonPatchOperation[] {
	if (op.changes && op.changes.length > 0) {
		return op.changes.flatMap(fromDiffOp);
	}
	return [{ op: 'replace', path: jsonPathToPointer(op.path), value: op.value }];
}

function fromDiffOp(op: DiffOp): JsonPatchOperation[] {
	switch (op.op) {
		case OpType.Add:
			return [{ op: 'add', path: jsonPathToPointer(op.path), value: op.value }];
		case OpType.Replace:
			return fromReplace(op);
		case OpType.Remove:
			return [{ op: 'remove', path: jsonPathToPointer(op.path) }];
		case OpType.Move:
			return [{ op: 'move', from: jsonPathToPointer(op.from), path: jsonPathToPointer(op.to) }];
		case OpType.Copy:
			return [{ op: 'copy', from: jsonPathToPointer(op.from), path: jsonPathToPointer(op.to) }];
		case OpType.Unchanged:
			// Informational only (diff(..., { includeUnchanged: true })) — not a change.
			return [];
		case OpType.Revert:
			// Only appears in exportChanges()/undo-stack ops, never in diff() output.
			// There's no RFC 6902 equivalent — "reset this path to base" isn't a patch op.
			throw new Error(
				`toJsonPatch: 'revert' has no RFC 6902 equivalent (path: ${op.path}). ` +
				`Only pass ops from diff(), not exportChanges().`,
			);
	}
}

// Converts DiffOp[] (from Engine/NodeEngine .diff()) into an RFC 6902
// compliant JSON Patch document — JSON Pointer addressed, using only the
// standard op vocabulary. This is the "diff" half: it doesn't recompute
// anything, it just re-expresses an existing diff in the standard format.
export function toJsonPatch(ops: DiffOp[]): JsonPatchDocument {
	return ops.flatMap(fromDiffOp);
}

// Structural type for anything diff()-able — satisfied by both Engine and
// NodeEngine without importing either as a value (mirrors tools.ts's
// EngineLike pattern, keeping this module a one-way dependent of engine.ts).
type Diffable = {
	diff(path?: string, options?: { key?: string; cascade?: boolean }): DiffOp[];
};

// Convenience: diff an engine (or scoped NodeEngine) straight to RFC 6902.
// Equivalent to `toJsonPatch(engine.diff(path, options))`.
export function diffPatch(engine: Diffable, path?: string, options?: { key?: string; cascade?: boolean }): JsonPatchDocument {
	return toJsonPatch(engine.diff(path, options));
}

// --- RFC 6901 JSON Pointer resolution + RFC 6902 apply ---------------------

function unescapePointerToken(token: string): string {
	return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(pointer: string): string[] {
	if (pointer === '') return [];
	if (pointer[0] !== '/') throw new Error(`invalid JSON Pointer '${pointer}': must be empty or start with '/'`);
	return pointer.slice(1).split('/').map(unescapePointerToken);
}

// RFC 6901 array-index ABNF: "0", or a non-zero digit followed by any digits.
// No leading zeros, no negative numbers, no whitespace.
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

// Resolves a pointer token to an array index. `forInsert` widens the valid
// range by one (arr.length is a legal insertion point; "-" means append) —
// used by add/copy/move-target, not by remove/replace/get which require an
// existing element.
function resolveArrayIndex(arr: JsonValue[], token: string, forInsert: boolean): number {
	if (token === '-') {
		if (!forInsert) throw new Error(`array index '-' is not valid here`);
		return arr.length;
	}
	if (!ARRAY_INDEX.test(token)) throw new Error(`invalid array index '${token}'`);
	const index = Number(token);
	const max = forInsert ? arr.length : arr.length - 1;
	if (index > max) throw new Error(`array index '${token}' out of bounds (length ${arr.length})`);
	return index;
}

function step(cur: JsonValue, token: string): JsonValue {
	if (Array.isArray(cur)) {
		return cur[resolveArrayIndex(cur, token, false)];
	}
	if (cur !== null && typeof cur === 'object') {
		if (!Object.prototype.hasOwnProperty.call(cur, token)) throw new Error(`member '${token}' does not exist`);
		return (cur as Record<string, JsonValue>)[token];
	}
	throw new Error(`cannot descend into a ${cur === null ? 'null' : typeof cur} at '${token}'`);
}

function getAt(doc: JsonValue, tokens: string[]): JsonValue {
	let cur = doc;
	for (const token of tokens) cur = step(cur, token);
	return cur;
}

// Resolves every token but the last, returning the parent container and the
// final token as key. Used by every op except whole-document add/replace
// (empty pointer) and remove (root can't be removed).
function navigateParent(root: JsonValue, tokens: string[]): { container: JsonValue; key: string } {
	const container = getAt(root, tokens.slice(0, -1));
	if (!Array.isArray(container) && (container === null || typeof container !== 'object')) {
		throw new Error(`cannot navigate into a ${container === null ? 'null' : typeof container}`);
	}
	return { container, key: tokens[tokens.length - 1] };
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	}
	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
		const ao = a as Record<string, JsonValue>;
		const bo = b as Record<string, JsonValue>;
		const aKeys = Object.keys(ao);
		return aKeys.length === Object.keys(bo).length &&
			aKeys.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
	}
	return false;
}

function opAdd(root: JsonValue, path: string, value: JsonValue): JsonValue {
	const tokens = parsePointer(path);
	const cloned = structuredClone(value);
	if (tokens.length === 0) return cloned;
	const { container, key } = navigateParent(root, tokens);
	if (Array.isArray(container)) {
		container.splice(resolveArrayIndex(container, key, true), 0, cloned);
	} else {
		(container as Record<string, JsonValue>)[key] = cloned;
	}
	return root;
}

function opRemove(root: JsonValue, path: string): JsonValue {
	const tokens = parsePointer(path);
	if (tokens.length === 0) throw new Error('cannot remove the root document');
	const { container, key } = navigateParent(root, tokens);
	if (Array.isArray(container)) {
		container.splice(resolveArrayIndex(container, key, false), 1);
	} else {
		if (!Object.prototype.hasOwnProperty.call(container, key)) throw new Error(`member '${key}' does not exist`);
		delete (container as Record<string, JsonValue>)[key];
	}
	return root;
}

function opReplace(root: JsonValue, path: string, value: JsonValue): JsonValue {
	const tokens = parsePointer(path);
	const cloned = structuredClone(value);
	if (tokens.length === 0) return cloned;
	const { container, key } = navigateParent(root, tokens);
	if (Array.isArray(container)) {
		container[resolveArrayIndex(container, key, false)] = cloned;
	} else {
		if (!Object.prototype.hasOwnProperty.call(container, key)) throw new Error(`member '${key}' does not exist`);
		(container as Record<string, JsonValue>)[key] = cloned;
	}
	return root;
}

// Per spec: "functionally identical to a 'remove' operation ... followed
// immediately by an 'add' operation at the target location". Sequential —
// `path` is resolved against the document *after* the removal, so moving an
// element later in the same array accounts for the shift the removal causes.
function opMove(root: JsonValue, from: string, path: string): JsonValue {
	if (path === from) {
		getAt(root, parsePointer(from)); // still validate `from` exists
		return root;
	}
	if (path.startsWith(from + '/')) throw new Error(`cannot move '${from}' into one of its own children ('${path}')`);
	const value = getAt(root, parsePointer(from));
	return opAdd(opRemove(root, from), path, value);
}

function opCopy(root: JsonValue, from: string, path: string): JsonValue {
	return opAdd(root, path, getAt(root, parsePointer(from)));
}

function opTest(root: JsonValue, path: string, value: JsonValue): JsonValue {
	if (!deepEqual(getAt(root, parsePointer(path)), value)) {
		throw new Error(`test failed: value at '${path}' does not match`);
	}
	return root;
}

function validateOperation(operation: JsonPatchOperation): void {
	const op = (operation as { op?: unknown }).op;
	if (typeof (operation as { path?: unknown }).path !== 'string') throw new Error(`operation is missing 'path'`);
	switch (op) {
		case 'add':
		case 'replace':
		case 'test':
			if (!('value' in operation)) throw new Error(`'${op}' operation requires 'value'`);
			return;
		case 'move':
		case 'copy':
			if (typeof (operation as { from?: unknown }).from !== 'string') throw new Error(`'${op}' operation requires 'from'`);
			return;
		case 'remove':
			return;
		default:
			throw new Error(`unsupported op '${String(op)}'`);
	}
}

function applyOne(root: JsonValue, operation: JsonPatchOperation): JsonValue {
	validateOperation(operation);
	switch (operation.op) {
		case 'add':     return opAdd(root, operation.path, operation.value);
		case 'remove':  return opRemove(root, operation.path);
		case 'replace': return opReplace(root, operation.path, operation.value);
		case 'move':    return opMove(root, operation.from, operation.path);
		case 'copy':    return opCopy(root, operation.from, operation.path);
		case 'test':    return opTest(root, operation.path, operation.value);
	}
}

// Applies an RFC 6902 JSON Patch document to a JSON value and returns the
// result. Pure: `document` is never mutated, and application is atomic — if
// any operation fails (bad pointer, missing member, out-of-bounds index,
// failed `test`), a JsonPatchError is thrown and the input is left
// completely untouched.
export function applyJsonPatch(document: JsonValue, patch: JsonPatchDocument): JsonValue {
	let root: JsonValue = structuredClone(document);
	for (let index = 0; index < patch.length; index++) {
		const operation = patch[index];
		try {
			root = applyOne(root, operation);
		} catch (e) {
			throw new JsonPatchError(e instanceof Error ? e.message : String(e), index, operation);
		}
	}
	return root;
}
