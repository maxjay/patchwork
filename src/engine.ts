import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export enum OpType {
	Add = 'add',
	Replace = 'replace',
	Remove = 'remove',
	Move = 'move',
	Copy = 'copy',
	Revert = 'revert',
}

// An Operation is a reversible action pushed onto the undo stack.
export interface Operation {
	undo: () => void;
	redo: () => void;
	op?: DiffOp;
}

// A DiffOp describes a single structural difference between two JSON values,
// expressed as a JSONPath + the relevant values. Unlike Operation, it has no
// knowledge of history or how to reverse anything — it's purely descriptive.
export type DiffOp =
	| { op: OpType.Add;     path: string; absolutePath?: string; value: JsonValue }
	| { op: OpType.Replace; path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue }
	| { op: OpType.Remove;  path: string; absolutePath?: string; value?: JsonValue }
	| { op: OpType.Move | OpType.Copy; from: string; to: string }
	| { op: OpType.Revert; path: string; absolutePath?: string };

// Path helpers used by NodeEngine.
//
// Normalized paths from paths() always end with `]` after the root token,
// so segment boundaries are unambiguous from raw string comparison:
//   prefix      $['cars']
//   sibling     $['carsTrucks']   — does NOT start with prefix + '['
//   child       $['cars'][0]      — DOES start with prefix + '['
//   self        $['cars']         — equals prefix exactly

function joinPath(prefix: string, childPath: string): string {
	// childPath always starts with $; strip it and concat to prefix
	return prefix + childPath.slice(1);
}

function rebasePath(fullPath: string, prefix: string): string {
	if (fullPath === prefix) return '$';
	return '$' + fullPath.slice(prefix.length);
}

function isUnderPrefix(fullPath: string, prefix: string): boolean {
	return fullPath === prefix || fullPath.startsWith(prefix + '[');
}

function rebaseDiffOp(op: DiffOp, prefix: string): DiffOp {
	// Switch (rather than if/else with spread) so TypeScript narrows the union
	// cleanly through each branch — spreading `op` doesn't preserve narrowing.
	switch (op.op) {
		case OpType.Move:
		case OpType.Copy:
			return { ...op, from: rebasePath(op.from, prefix), to: rebasePath(op.to, prefix) };
		case OpType.Add:
		case OpType.Replace:
		case OpType.Remove:
		case OpType.Revert:
			return { ...op, path: rebasePath(op.path, prefix) };
	}
}

function opPath(op: DiffOp): string {
	switch (op.op) {
		case OpType.Move:
		case OpType.Copy:
			return op.from;
		case OpType.Add:
		case OpType.Replace:
		case OpType.Remove:
		case OpType.Revert:
			return op.path;
	}
}

function extractKeyMap(schema: Record<string, any>, path = '$'): Map<string, string> {
	const map = new Map<string, string>();
	if (schema['x-key']) map.set(path, schema['x-key'] as string);
	if (schema.properties) {
		for (const [key, sub] of Object.entries(schema.properties)) {
			for (const [p, k] of extractKeyMap(sub as Record<string, any>, `${path}['${key}']`))
				map.set(p, k);
		}
	}
	if (schema.items && isPlainObject(schema.items)) {
		for (const [p, k] of extractKeyMap(schema.items as Record<string, any>, `${path}[*]`))
			map.set(p, k);
	}
	return map;
}

function toPathPattern(path: string): string {
	return path.replace(/\[\d+\]/g, '[*]');
}

// In-place write at a non-root path against any target object. Used by
// NodeEngine.accept/decline to mutate parent.base/draft at a subtree.
function setOnTarget(target: any, segments: (string | number)[], value: any): void {
	let cur = target;
	for (let i = 0; i < segments.length - 1; i++) cur = cur[segments[i]];
	const key = segments[segments.length - 1];
	cur[key] = value;
}

export class Engine<T extends JsonValue = JsonValue> {
	// The committed source of truth. Mutated only by accept() (promoting draft
	// into base) and by undo/redo of accept itself. Read by diff() to know what
	// to compare against, and by revert() to know what to restore.
	base: T;

	// The working copy. All mutating ops (add/replace/delete/move/copy/revert)
	// modify draft in place. accept() snapshots draft into base; decline()
	// resets draft from base.
	draft: T;

	// Two stacks that implement linear undo/redo. Every mutating operation pushes
	// an Operation onto undoStack. Calling undo() pops from undoStack and pushes
	// onto redoStack so it can be replayed. Any new operation clears redoStack,
	// because you can't branch history — the redo path is abandoned.
	private undoStack: Operation[] = [];
	private redoStack: Operation[] = [];
	private ephemeralStart = -1;
	private keyMap: Map<string, string> = new Map();

	constructor(base: T, options?: { schema?: Record<string, any> }) {
		this.base = structuredClone(base);
		this.draft = structuredClone(this.base);
		if (options?.schema) this.keyMap = extractKeyMap(options.schema);
	}

	/** @internal */
	pushOperation(op: Operation) {
		this.undoStack.push(op);
		this.redoStack = []; // branching discards redo history
	}

	undo(): void {
		if (this.undoStack.length === this.ephemeralStart) return;
		const op = this.undoStack.pop();
		if (op) {
			op.undo();
			this.redoStack.push(op);
		}
	}

	redo(): void {
		const op = this.redoStack.pop();
		if (op) {
			op.redo();
			this.undoStack.push(op);
		}
	}

	beginEphemeral(): void {
		if (this.ephemeralStart !== -1) throw new Error('beginEphemeral: already in an ephemeral session');
		this.ephemeralStart = this.undoStack.length;
	}

	commitEphemeral(): void {
		if (this.ephemeralStart === -1) throw new Error('commitEphemeral: not in an ephemeral session');
		const ops = this.undoStack.splice(this.ephemeralStart);
		this.ephemeralStart = -1;
		if (ops.length === 0) return;
		this.pushOperation({
			undo: () => { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); },
			redo: () => { for (const op of ops) op.redo(); },
		});
	}

	discardEphemeral(): void {
		if (this.ephemeralStart === -1) throw new Error('discardEphemeral: not in an ephemeral session');
		const ops = this.undoStack.splice(this.ephemeralStart);
		this.ephemeralStart = -1;
		for (let i = ops.length - 1; i >= 0; i--) ops[i].undo();
		this.redoStack = [];
	}

	// Promotes the current draft to base. After accept(), base equals draft.
	// Draft itself is untouched — only base moves. Undo restores the previous
	// base; redo re-installs the snapshot taken at accept time.
	accept(): void {
		const oldBase = this.base;
		const newBase = structuredClone(this.draft);
		this.base = newBase;
		this.pushOperation({
			undo: () => { this.base = oldBase; },
			redo: () => { this.base = newBase; },
		});
	}

	// Discards pending edits — draft is reset from a fresh clone of base.
	// Base is untouched. Undo restores the previous draft; redo re-installs
	// a clean clone of the base-at-decline-time.
	decline(): void {
		const oldDraft = this.draft;
		const snapshot = structuredClone(this.base);
		this.draft = structuredClone(snapshot);
		this.pushOperation({
			undo: () => { this.draft = oldDraft; },
			redo: () => { this.draft = structuredClone(snapshot); },
		});
	}

	// Returns every value in draft that matches the JSONPath query, each paired
	// with its normalized path. The path is what mutating ops accept, so result
	// entries can be fed straight into replace/delete/etc.
	get(jsonPath: string): Array<{ path: string; value: JsonValue }> {
		const matched = paths(this.draft, jsonPath);
		return matched.map(p => ({
			path: p,
			value: this.getAt(this.segmentsFrom(p)),
		}));
	}

	// Strict single-match read. Throws an Error when the path resolves to more
	// than one value (ambiguous), and throws `undefined` itself when it resolves
	// to none — the missing value is signalled by throwing the absence.
	getValue(jsonPath: string): JsonValue {
		const matched = paths(this.draft, jsonPath);
		if (matched.length > 1) {
			throw new Error(`getValue: path resolved to ${matched.length} values, expected exactly one`);
		}
		if (matched.length === 0) {
			throw undefined;
		}
		return this.getAt(this.segmentsFrom(matched[0]));
	}

	// Returns a scoped lens onto a sub-path of this engine. The child shares
	// state with the parent: mutations through either are visible in both,
	// undo/redo runs against the parent's stack, but accept/decline/diff on
	// the child are scoped to its subtree. The path must resolve to exactly
	// one existing node; throws otherwise.
	getNodeEngine<U extends JsonValue = JsonValue>(jsonPath: string): NodeEngine<U> {
		const matched = paths(this.draft, jsonPath);
		if (matched.length !== 1) {
			throw new Error(`getNodeEngine: path must resolve to exactly one node, got ${matched.length}`);
		}
		return new NodeEngine<U>(this as Engine<JsonValue>, matched[0]);
	}

	add(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		if (normalizedPaths.length === 0) {
			// Path didn't resolve to anything in the document. Two reasons this happens:
			//   1. It's a query (wildcard, filter, slice, descendant) that matched nothing
			//      — nothing to create, so do nothing.
			//   2. It's a literal path to a key/index that doesn't exist yet
			//      — create the node (supports deep creation, e.g. $.a.b.c).
			if (this.isQueryPath(jsonPath)) return;
			this.upsertAt(this.segmentsFrom(jsonPath), value);
			return;
		}
		const segmentsList = normalizedPaths.map(np => this.segmentsFrom(np));

		const isArrayInsert = segmentsList.map(seg => {
			if (seg.length === 0) return false;
			let current: any = this.draft;
			for (let i = 0; i < seg.length - 1; i++) current = current[seg[i]];
			return Array.isArray(current) && typeof seg[seg.length - 1] === 'number';
		});

		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg)));
		const valueToInsert = structuredClone(value);

		const doAdd = () => {
			// Reverse to preserve array indices when inserting at multiple positions
			for (let i = segmentsList.length - 1; i >= 0; i--) {
				this.insertAt(segmentsList[i], structuredClone(valueToInsert));
			}
		};

		const undoAdd = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				if (isArrayInsert[i]) {
					this.removeAt(segmentsList[i]);
				} else {
					this.setAt(segmentsList[i], structuredClone(oldValues[i]));
				}
			}
		};

		doAdd();
		const op = { op: OpType.Add, path: jsonPath, value: valueToInsert as JsonValue } as DiffOp;
		this.pushOperation({ op, undo: undoAdd, redo: doAdd });
	}

	replace(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		const segmentsList = normalizedPaths.map(np => this.segmentsFrom(np));
		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg)));
		const valueToSet = structuredClone(value);

		const doReplace = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				this.setAt(segmentsList[i], structuredClone(valueToSet));
			}
		};

		const undoReplace = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				this.setAt(segmentsList[i], structuredClone(oldValues[i]));
			}
		};

		doReplace();
		const op = { op: OpType.Replace, path: jsonPath, value: valueToSet as JsonValue } as DiffOp;
		this.pushOperation({ op, undo: undoReplace, redo: doReplace });
	}

	delete(jsonPath: string): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		const segmentsList = normalizedPaths.map(np => this.segmentsFrom(np));
		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg)));

		const doDelete = () => {
			// Reverse to preserve array indices when removing multiple elements
			for (let i = segmentsList.length - 1; i >= 0; i--) {
				this.removeAt(segmentsList[i]);
			}
		};

		const undoDelete = () => {
			// Forward order to preserve array indices when restoring multiple elements
			for (let i = 0; i < segmentsList.length; i++) {
				this.insertAt(segmentsList[i], structuredClone(oldValues[i]));
			}
		};

		doDelete();
		const op = { op: OpType.Remove, path: jsonPath } as DiffOp;
		this.pushOperation({ op, undo: undoDelete, redo: doDelete });
	}

	revert(jsonPath: string): void {
		const pathsDraft = paths(this.draft, jsonPath);
		const pathsBase = paths(this.base, jsonPath);
		const allPaths = Array.from(new Set([...pathsDraft, ...pathsBase]));

		const segmentsList = allPaths.map(np => this.segmentsFrom(np));

		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg, this.draft)));
		const targetValues = segmentsList.map(seg => structuredClone(this.getAt(seg, this.base)));

		const doRevert = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				const val = targetValues[i];
				if (val === undefined) {
					this.removeAt(segmentsList[i]);
				} else {
					this.setAt(segmentsList[i], structuredClone(val));
				}
			}
		};

		const undoRevert = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				const val = oldValues[i];
				if (val === undefined) {
					this.removeAt(segmentsList[i]);
				} else {
					this.setAt(segmentsList[i], structuredClone(val));
				}
			}
		};

		doRevert();
		const op = { op: OpType.Revert, path: jsonPath } as DiffOp;
		this.pushOperation({ op, undo: undoRevert, redo: doRevert });
	}

	// Returns the net difference between base and draft as a flat list of
	// DiffOps. A snapshot comparison — tells you *what changed* from committed
	// to working, not *how* or *how many times*.
	//
	// Independent of the undo stack: if you replace $.a twice and then undo
	// both, diff() returns []. The stack would still have seen two operations.
	//
	// Pass options.key to enable identity-based array diffing for the matched
	// path without needing a schema.
	diff(path?: string, options?: { key?: string }): DiffOp[] {
		if (options?.key && path) {
			const resolved = paths(this.draft, path)[0] ?? paths(this.base, path)[0];
			if (resolved) {
				const saved = this.keyMap;
				this.keyMap = new Map([...this.keyMap, [resolved, options.key]]);
				try { return this._diff(path); }
				finally { this.keyMap = saved; }
			}
		}
		return this._diff(path);
	}

	private _diff(path?: string): DiffOp[] {
		const ops: DiffOp[] = [];
		this.diffNode(this.base, this.draft, '$', ops);
		if (!path) return ops;
		const prefixes = [...new Set([...paths(this.draft, path), ...paths(this.base, path)])];
		return ops.filter(op => prefixes.some(p => isUnderPrefix(opPath(op), p)));
	}

	private moveOrCopy(from: string, to: string, isMove: boolean): void {
		// get single source path + value
		const normalizedFromPaths = this.jsonPathToNormalizedPaths(from);
		if (normalizedFromPaths.length !== 1) {
			throw new Error(`${isMove ? 'Move' : 'Copy'} source must resolve to exactly one path, got ${normalizedFromPaths.length}`);
		}
		const fromSegments = this.segmentsFrom(normalizedFromPaths[0]);
		const sourceValue = structuredClone(this.getAt(fromSegments));

		// get target paths, along with if they already exist + current value
		const normalizedToPaths = this.jsonPathToNormalizedPaths(to);
		const toPaths = normalizedToPaths.length === 0
			? to.includes('*') // TODO: better validation of of unknown paths
				? (() => { throw new Error(`Invalid JSONPath: ${to}`); })()
				: [to]
			: normalizedToPaths;
		const targetMeta = toPaths.map(path => {
			const segments = this.segmentsFrom(path);
			const exists = normalizedToPaths.length > 0;
			return {
				segments,
				exists,
				oldValue: exists ? structuredClone(this.getAt(segments)) : undefined,
			};
		});

		// check operation isn't against itself
		const isSelfOperation = targetMeta.length === 1 && this.isSegmentsEqual(targetMeta[0].segments, fromSegments);
		if (isSelfOperation && isMove) {
			// no-op
			return;
		}
		if (isMove && targetMeta.some(target => target.segments.length > fromSegments.length &&
			this.isSegmentsEqual(target.segments.slice(0, fromSegments.length), fromSegments))) {
			throw new Error('Invalid move target: cannot move a path into one of its own descendants');
		}

		// check if we're removing from an array (for undo to know whether to insert or set)
		let isArrayRemoval = false;
		if (isMove) {
			const container = fromSegments.length === 0 ? this.draft : this.getAt(fromSegments.slice(0, -1));
			isArrayRemoval = Array.isArray(container) && typeof fromSegments[fromSegments.length - 1] === 'number';
		}

		const doOperation = () => {
			for (const target of targetMeta) {
				this.setAt(target.segments, structuredClone(sourceValue));
			}
			if (isMove) {
				this.removeAt(fromSegments);
			}
		};

		const undoOperation = () => {
			for (const target of targetMeta) {
				if (target.exists) {
					this.setAt(target.segments, structuredClone(target.oldValue));
				} else {
					this.removeAt(target.segments);
				}
			}
			if (isMove) {
				// if we removed from an array, we need to insert at the original index (not just set) to preserve the array structure and indices
				if (isArrayRemoval) {
					this.insertAt(fromSegments, structuredClone(sourceValue));
				} else {
					this.setAt(fromSegments, structuredClone(sourceValue));
				}
			}
		};

		doOperation();
		const op = { op: isMove ? OpType.Move : OpType.Copy, from, to } as DiffOp;
		this.pushOperation({ op, undo: undoOperation, redo: doOperation });
	}

	move(from: string, to: string): void {
		this.moveOrCopy(from, to, true);
	}

	copy(from: string, to: string): void {
		this.moveOrCopy(from, to, false);
	}

	exportChanges(): DiffOp[] {
		return this.undoStack.map(op => op.op).filter(op => op !== undefined);
	}

	importChanges(ops: DiffOp[]): void {
		let progress = 0;
		try {
			for (const op of ops) {
				switch (op.op) {
					case OpType.Add:
						this.add(op.path, op.value);
						break;
					case OpType.Replace:
						this.replace(op.path, op.value);
						break;
					case OpType.Remove:
						this.delete(op.path);
						break;
					case OpType.Move:
						this.move(op.from, op.to);
						break;
					case OpType.Copy:
						this.copy(op.from, op.to);
						break;
					case OpType.Revert:
						this.revert(op.path);
						break;
					default:
						console.warn(`Unknown operation type: ${(op as any).op}`);
				}
			}
		} catch (e) {
			for (let i = 0; i < progress; i++) {
				this.undo();
			}
			throw new Error(`Failed to import changes at operation index ${progress}: ${(e as Error).message}`, { cause: e});
		}
	}

	// Recursively walks two JSON values in parallel, building up a flat list of
	// DiffOps. Paths are expressed in normalized JSONPath notation (e.g. $['a'][0]).
	//
	// Three structural cases:
	//   - Both arrays: compare index-by-index up to the longer length. Extra
	//     indices on b are 'add', extra on a are 'remove'.
	//   - Both plain objects: union all keys. Key only in b is 'add', only in a
	//     is 'remove', in both → recurse deeper.
	//   - Anything else (type mismatch, or two primitives): if they differ,
	//     emit a 'replace'. This is the leaf case — we stop recursing here
	//     because there's no deeper structure to compare.
	private diffArrayByKey(
		a: JsonValue[], b: JsonValue[],
		path: string, key: string, ops: DiffOp[]
	): void {
		const aMap = new Map(a.map((item, i) => [(item as any)[key], { item, i }]));
		const bMap = new Map(b.map((item, i) => [(item as any)[key], { item, i }]));

		for (const [id, { item, i }] of aMap)
			if (!bMap.has(id)) ops.push({ op: OpType.Remove, path: `${path}[${i}]`, value: item });

		for (const [id, { item, i }] of bMap)
			if (!aMap.has(id)) ops.push({ op: OpType.Add, path: `${path}[${i}]`, value: item });

		for (const [id, { item: bItem, i: bIndex }] of bMap)
			if (aMap.has(id)) this.diffNode(aMap.get(id)!.item, bItem, `${path}[${bIndex}]`, ops);
	}

	// $self set diff: the item itself is its identity. Reduces to symmetric set
	// difference because JS Set already gives value-equality for primitives.
	// Duplicates collapse and reorders are invisible — both are correct under
	// the set semantics that `$self` declares.
	//
	// Restricted to primitive items: JS Set/Map use reference equality for
	// objects, so `[{a:1}]` vs `[{a:1}]` would compare as fully different sets.
	// Extending to objects requires synthesising structural identity in
	// userland (canonical-JSON normalization or deep-equal scan); both walk
	// the item structure, and for nearly all real schemas `x-key: '<field>'`
	// is the cleaner answer when items have a natural ID. Tracked in #18.
	private diffArrayBySelf(
		a: JsonValue[], b: JsonValue[],
		path: string, ops: DiffOp[]
	): void {
		for (const arr of [a, b]) {
			for (const item of arr) {
				if (item !== null && typeof item === 'object') {
					throw new Error(
						`diff: x-key '$self' at ${path} requires primitive items, got ` +
						`${Array.isArray(item) ? 'array' : 'object'}. ` +
						`Use x-key: '<field>' for arrays of objects. See #18.`
					);
				}
			}
		}
		const aMap = new Map<JsonValue, number>();
		a.forEach((item, i) => aMap.set(item, i));
		const bMap = new Map<JsonValue, number>();
		b.forEach((item, i) => bMap.set(item, i));

		for (const [item, i] of aMap)
			if (!bMap.has(item)) ops.push({ op: OpType.Remove, path: `${path}[${i}]`, value: item });

		for (const [item, i] of bMap)
			if (!aMap.has(item)) ops.push({ op: OpType.Add, path: `${path}[${i}]`, value: item });
	}

	private diffNode(a: JsonValue, b: JsonValue, path: string, ops: DiffOp[]): void {
		if (Array.isArray(a) && Array.isArray(b)) {
			const key = this.keyMap.get(path) ?? this.keyMap.get(toPathPattern(path));
			if (key === '$self') { this.diffArrayBySelf(a, b, path, ops); return; }
			if (key) { this.diffArrayByKey(a, b, path, key, ops); return; }
			const maxLen = Math.max(a.length, b.length);
			for (let i = 0; i < maxLen; i++) {
				const child = `${path}[${i}]`;
				if (i >= a.length) ops.push({ op: OpType.Add, path: child, value: b[i] });
				else if (i >= b.length) ops.push({ op: OpType.Remove, path: child, value: a[i] });
				else this.diffNode(a[i], b[i], child, ops);
			}
		} else if (isPlainObject(a) && isPlainObject(b)) {
			const ao = a as Record<string, JsonValue>;
			const bo = b as Record<string, JsonValue>;
			const allKeys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
			for (const key of allKeys) {
				const child = `${path}['${key}']`;
				if (!(key in ao)) ops.push({ op: OpType.Add, path: child, value: bo[key] });
				else if (!(key in bo)) ops.push({ op: OpType.Remove, path: child, value: ao[key] });
				else this.diffNode(ao[key], bo[key], child, ops);
			}
		} else if (a !== b) {
			// Covers: same-type primitives with different values, and type changes
			// (e.g. object → array). In both cases there's nothing to recurse into.
			ops.push({ op: OpType.Replace, path, oldValue: a, value: b });
		}
	}

	// Returns true if the path contains any non-literal selector — wildcard, filter,
	// slice, or descendant. These are query selectors that target existing nodes;
	// they can't be used to create new ones, so add() should no-op when they match nothing.
	private isQueryPath(jsonPath: string): boolean {
		const ast = parse(jsonPath);
		return ast.segments.some(seg => {
			if (seg.type === 'DescendantSegment') return true;
			const node = seg.node;
			if (node.type === 'WildcardSelector') return true;
			if (node.type === 'BracketedSelection') {
				return node.selectors.some(s =>
					s.type === 'WildcardSelector' ||
					s.type === 'FilterSelector' ||
					s.type === 'SliceSelector'
				);
			}
			return false;
		});
	}

	// Uses the library parser to extract (string | number) segments from a JSONPath.
	// Works on both normalized paths (output of paths()) and simple literal paths.
	/** @internal */
	segmentsFrom(jsonPath: string): (string | number)[] {
		const ast = parse(jsonPath);
		const segments: (string | number)[] = [];
		for (const segment of ast.segments) {
			const node = segment.node;
			if (node.type === 'MemberNameShorthand') {
				segments.push(node.value);
			} else if (node.type === 'BracketedSelection') {
				const selector = node.selectors[0];
				if (selector.type === 'NameSelector') {
					segments.push(selector.value);
				} else if (selector.type === 'IndexSelector') {
					segments.push(selector.value);
				}
			}
		}
		return segments;
	}

	/** @internal */
	getAt(segments: (string | number)[], source: any = this.draft): any {
		if (segments.length === 0) return source;
		let current: any = source;
		for (let i = 0; i < segments.length - 1; i++) {
			if (current === undefined || current === null) return undefined;
			current = current[segments[i]];
		}
		if (current === undefined || current === null) return undefined;
		return current[segments[segments.length - 1]];
	}

	private isSegmentsEqual(a: (string | number)[], b: (string | number)[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	private setAt(segments: any[], value: any): void {
		if (segments.length === 0) { this.draft = value as T; return; }
		// basically, for every segment except the last, we try to access the next level.
		// if it doesn't exist, we create an object or array depending on the next segment type.
		// so for example, if we have segments ['a', 'b', 'c', 0, 'd'], we first check if draft['a'] exists.
		// If not, we create it as an object (since the next segment is 'b').
		// Given that we've had to create b, we don't need to check to see if the rest exist as we know they don't
		// so we can just create them all in one go.
		// So C is created as an array since the next segment is an index
		// And then at that index we create the object
		let current: any = this.draft;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const nextSegment = segments[i + 1];

			const next = current[segment];

			const canGoNext =
				next !== undefined &&
				next !== null &&
				typeof next === 'object';

			if (!canGoNext) {
				current[segment] = typeof nextSegment === 'number' ? [] : {};
			}

			current = current[segment];
		}

		const finalSegment = segments[segments.length - 1];
		current[finalSegment] = value;
	}

	// Sets `value` at `segments`, fabricating any missing intermediate
	// objects/arrays via setAt, and pushes an Operation that reverses it.
	//
	// The reverse target is the deepest *existing* point on the path, not
	// the leaf — if we had to invent `c.d` to write `a.b.c.d`, undo restores
	// what was at `a.b` (overwriting the fabricated subtree wholesale) rather
	// than trying to surgically remove just the leaf.
	private upsertAt(segments: (string | number)[], value: any): void {
		const restore = this.findRestorePoint(segments);
		const valueToSet = structuredClone(value);

		const doUpsert = () => {
			this.setAt(segments, structuredClone(valueToSet));
		};

		const undoUpsert = () => {
			if (restore.existed) this.setAt(restore.segments, structuredClone(restore.oldValue));
			else this.removeAt(restore.segments);
		};

		doUpsert();
		const op = { op: OpType.Add, path: '$.' + segments.join('.'), value: valueToSet as JsonValue } as DiffOp;
		this.pushOperation({ op, undo: undoUpsert, redo: doUpsert });
	}

	// Finds the deepest existing prefix of `segments` — the point upsertAt
	// needs to snapshot, because anything past it will be fabricated by setAt.
	private findRestorePoint(segments: (string | number)[]): {
		segments: (string | number)[];
		existed: boolean;
		oldValue: any;
	} {
		if (segments.length === 0) {
			return { segments, existed: true, oldValue: structuredClone(this.draft) };
		}
		let current: any = this.draft;
		let stopAt = segments.length - 1; // default: all intermediates exist, restore at the leaf
		for (let i = 0; i < segments.length - 1; i++) {
			const next = current[segments[i]];
			if (next === null || typeof next !== 'object') {
				stopAt = i;
				break;
			}
			current = next;
		}
		const key = segments[stopAt];
		return {
			segments: segments.slice(0, stopAt + 1),
			existed: Object.prototype.hasOwnProperty.call(current, key),
			oldValue: structuredClone(current[key]),
		};
	}

	// add semantics: splices into arrays, sets on objects
	private insertAt(segments: (string | number)[], value: any): void {
		if (segments.length === 0) { this.draft = value as T; return; }
		let current: any = this.draft;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		const key = segments[segments.length - 1];
		if (Array.isArray(current) && typeof key === 'number') {
			current.splice(key, 0, value);
		} else {
			current[key] = value;
		}
	}

	private removeAt(segments: (string | number)[]): void {
		if (segments.length === 0) return;
		let current: any = this.draft;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		const key = segments[segments.length - 1];
		if (Array.isArray(current) && typeof key === 'number') {
			current.splice(key, 1);
		} else {
			delete current[key as string];
		}
	}

	// jsonPath is a query selector, not a JSON Pointer. We need to convert it to a JSON Pointer before we can use it.
	// '$.store.book[*].author'; as an example
	private jsonPathToNormalizedPaths(jsonPath: string): string[] {
		return paths(this.draft, jsonPath);
	}
}

// A scoped lens over a sub-path of a parent Engine. Owns no state itself —
// only a reference to the parent and a normalized path prefix. All reads
// resolve through the parent every time (so the child stays attached even
// if the parent reassigns the subtree), and all writes forward to the
// parent's methods with paths rewritten into the parent's frame.
//
// Mutating ops share the parent's undo stack; undo()/redo() are pure
// delegates. accept()/decline()/diff() are scoped to the subtree.
export class NodeEngine<T extends JsonValue = JsonValue> {
	private segs: (string | number)[];

	constructor(
		private parent: Engine<JsonValue>,
		private prefix: string,
	) {
		this.segs = parent.segmentsFrom(prefix);
	}

	get base(): T {
		return this.parent.getAt(this.segs, this.parent.base) as T;
	}

	get draft(): T {
		return this.parent.getAt(this.segs, this.parent.draft) as T;
	}

	// Mutations — rewrite path into parent frame, forward to parent.

	add(jsonPath: string, value: any): void {
		this.parent.add(joinPath(this.prefix, jsonPath), value);
	}

	replace(jsonPath: string, value: any): void {
		this.parent.replace(joinPath(this.prefix, jsonPath), value);
	}

	delete(jsonPath: string): void {
		this.parent.delete(joinPath(this.prefix, jsonPath));
	}

	revert(jsonPath: string): void {
		this.parent.revert(joinPath(this.prefix, jsonPath));
	}

	move(from: string, to: string): void {
		this.parent.move(joinPath(this.prefix, from), joinPath(this.prefix, to));
	}

	copy(from: string, to: string): void {
		this.parent.copy(joinPath(this.prefix, from), joinPath(this.prefix, to));
	}

	// Reads — forward then rebase any returned paths back into the child frame.

	get(jsonPath: string): Array<{ path: string; value: JsonValue }> {
		return this.parent.get(joinPath(this.prefix, jsonPath))
			.map(r => ({ path: rebasePath(r.path, this.prefix), value: r.value }));
	}

	getValue(jsonPath: string): JsonValue {
		return this.parent.getValue(joinPath(this.prefix, jsonPath));
	}

	// History — pure delegation. The parent owns the stack; whether the last
	// op originated through this child or directly through the parent is
	// irrelevant for undo/redo.

	undo(): void { this.parent.undo(); }
	redo(): void { this.parent.redo(); }

	// Subtree-scoped accept: replace ONLY the prefix subtree of parent.base
	// with a clone of the same subtree of parent.draft. Trucks (or anything
	// else outside the prefix) in parent.base stay untouched.
	accept(): void {
		const oldBase = structuredClone(this.parent.getAt(this.segs, this.parent.base));
		const newBase = structuredClone(this.parent.getAt(this.segs, this.parent.draft));
		setOnTarget(this.parent.base, this.segs, newBase);
		this.parent.pushOperation({
			undo: () => setOnTarget(this.parent.base, this.segs, oldBase),
			redo: () => setOnTarget(this.parent.base, this.segs, structuredClone(newBase)),
		});
	}

	// Subtree-scoped decline: replace ONLY the prefix subtree of parent.draft
	// with a clone of the same subtree of parent.base.
	decline(): void {
		const oldDraft = structuredClone(this.parent.getAt(this.segs, this.parent.draft));
		const newDraft = structuredClone(this.parent.getAt(this.segs, this.parent.base));
		setOnTarget(this.parent.draft, this.segs, newDraft);
		this.parent.pushOperation({
			undo: () => setOnTarget(this.parent.draft, this.segs, oldDraft),
			redo: () => setOnTarget(this.parent.draft, this.segs, structuredClone(newDraft)),
		});
	}

	// Scoped diff: ops under the prefix with paths rebased to the child's frame.
	// Each op also carries absolutePath so callers that need the full document
	// path don't have to re-join it themselves.
	diff(path?: string, options?: { key?: string }): DiffOp[] {
		return this.parent.diff(
			path ? joinPath(this.prefix, path) : undefined,
			options,
		)
			.filter(op => isUnderPrefix(opPath(op), this.prefix))
			.map(op => {
				const rebased = rebaseDiffOp(op, this.prefix);
				if ('path' in rebased) return { ...rebased, absolutePath: (op as any).path };
				return rebased;
			});
	}

	// Nested children compose by joining paths and creating a fresh lens
	// against the same root parent.
	getNodeEngine<U extends JsonValue = JsonValue>(jsonPath: string): NodeEngine<U> {
		return this.parent.getNodeEngine<U>(joinPath(this.prefix, jsonPath));
	}
}
