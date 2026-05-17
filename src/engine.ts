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
	| { op: OpType.Add;     path: string; value: JsonValue }
	| { op: OpType.Replace; path: string; oldValue?: JsonValue; value: JsonValue }
	| { op: OpType.Remove;  path: string; value?: JsonValue }
	| { op: OpType.Move | OpType.Copy; from: string; to: string }
	| { op: OpType.Revert; path: string };

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

	constructor(base: T) {
		this.base = structuredClone(base);
		this.draft = structuredClone(this.base);
	}

	private pushOperation(op: Operation) {
		this.undoStack.push(op);
		this.redoStack = []; // branching discards redo history
	}

	undo(): void {
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
	diff(): DiffOp[] {
		const ops: DiffOp[] = [];
		this.diffNode(this.base, this.draft, '$', ops);
		return ops;
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
	private diffNode(a: JsonValue, b: JsonValue, path: string, ops: DiffOp[]): void {
		if (Array.isArray(a) && Array.isArray(b)) {
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
	private segmentsFrom(jsonPath: string): (string | number)[] {
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

	private getAt(segments: (string | number)[], source: any = this.draft): any {
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
		console.log(segments);
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

// Test
const engine = new Engine<any>({ a: { b: 3 } });
engine.add('$.a.b.c[0].d', 5);
console.log(engine.draft);
console.log(engine.draft.a.b.c[0].d);
engine.add('$.a.b', 3);
console.log(engine.draft);
engine.add('$.a.b', []);
engine.add('$.a.b[0]', 2);
engine.add('$.a.b[0]', 1);
engine.add('$.a.b[0]', 0);
console.log(engine.draft);
engine.move('$.a.b[1]', '$.a.c');
console.log(engine.draft);
engine.copy('$.a.c', '$.a.b[*]');
console.log(engine.draft);

console.log(engine.diff());
console.log(engine.exportChanges());
