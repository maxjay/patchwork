import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An Operation is a reversible action pushed onto the undo stack. It intentionally
// carries no metadata about what changed — just how to reverse or reapply it.
// This is different from DiffOp, which describes *what* is different between two
// snapshots. Operations are about history; DiffOps are about net state.
export interface Operation {
	// TODO: op type + path + value, will allow us to build up a 'op log' for export
	undo: () => void;
	redo: () => void;
}

// A DiffOp describes a single structural difference between two JSON values,
// expressed as a JSONPath + the relevant values. Unlike Operation, it has no
// knowledge of history or how to reverse anything — it's purely descriptive.
export type DiffOp =
	| { op: 'add'; path: string; value: JsonValue }
	| { op: 'remove'; path: string; value: JsonValue }
	| { op: 'replace'; path: string; oldValue: JsonValue; value: JsonValue };

export class Engine<T extends JsonValue = JsonValue> {
	base: T;

	// A deep clone of the initial base, taken at construction time and never mutated.
	// Used by diff() to compute what has net-changed across the whole session.
	// The undo/redo stacks cannot serve this role — they only know how to reverse
	// individual steps, not what the document looked like before any edits.
	private readonly original: T;

	// Two stacks that implement linear undo/redo. Every mutating operation pushes
	// an Operation onto undoStack. Calling undo() pops from undoStack and pushes
	// onto redoStack so it can be replayed. Any new operation clears redoStack,
	// because you can't branch history — the redo path is abandoned.
	private undoStack: Operation[] = [];
	private redoStack: Operation[] = [];

	// Ordered list of explicitly accepted snapshots. accept() appends here;
	// decline() reads the last entry to revert base. Kept separate from the undo
	// stack so decline() can find the last checkpoint in O(1) without inspecting
	// the stack contents. Undo/redo of accept and decline mutate this list too,
	// so it stays consistent with the rest of the history.
	private checkpoints: T[] = [];

	constructor(base: T) {
		this.original = structuredClone(base);
		this.base = base;
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

	// Snapshots the current draft as a checkpoint without touching base.
	// Undo removes the checkpoint; redo re-adds it.
	accept(): void {
		const snapshot = structuredClone(this.base);
		this.checkpoints.push(snapshot);
		this.pushOperation({
			undo: () => { this.checkpoints.pop(); },
			redo: () => { this.checkpoints.push(structuredClone(snapshot)); },
		});
	}

	// Reverts base to the most recent checkpoint, or to original if none exist.
	// The individual-op undo/redo stacks are left intact so that undoing this
	// decline restores the full draft history too.
	decline(): void {
		if (this.checkpoints.length === 0 && this.base === this.original) {
			// no-op
			return;
		}
		const target = this.checkpoints.length > 0
			? this.checkpoints[this.checkpoints.length - 1]
			: this.original;
		const previousDraft = structuredClone(this.base);
		this.base = structuredClone(target);
		this.pushOperation({
			undo: () => { this.base = previousDraft; },
			redo: () => { this.base = structuredClone(target); },
		});
	}

	add(jsonPath: string, value: any): void {
		// const segments = this.segmentsFrom(jsonPath);
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
			let current: any = this.base;
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
		this.pushOperation({ undo: undoAdd, redo: doAdd });
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
		this.pushOperation({ undo: undoReplace, redo: doReplace });
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
		this.pushOperation({ undo: undoDelete, redo: doDelete });
	}

	revert(jsonPath: string): void {
		const pathsBase = paths(this.base, jsonPath);
		const pathsOrig = paths(this.original, jsonPath);
		const allPaths = Array.from(new Set([...pathsBase, ...pathsOrig]));

		const segmentsList = allPaths.map(np => this.segmentsFrom(np));

		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg, this.base)));
		const targetValues = segmentsList.map(seg => structuredClone(this.getAt(seg, this.original)));

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
		this.pushOperation({ undo: undoRevert, redo: doRevert });
	}

	// Returns the net difference between the original base (at construction) and
	// the current base, as a flat list of DiffOps. This is a snapshot comparison —
	// it tells you *what changed*, not *how* or *how many times*.
	//
	// This is intentionally separate from the undo stack. The stack records every
	// individual operation and knows how to reverse each one. diff() doesn't care
	// about history: if you replace $.a twice and then undo both, diff() returns [].
	// The stack would still have seen two operations go through it.
	diff(): DiffOp[] {
		const ops: DiffOp[] = [];
		this.diffNode(this.original, this.base, '$', ops);
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
			? to.includes('*')
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
			const container = fromSegments.length === 0 ? this.base : this.getAt(fromSegments.slice(0, -1));
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
		this.pushOperation({ undo: undoOperation, redo: doOperation });
	}

	move(from: string, to: string): void {
		this.moveOrCopy(from, to, true);
	}

	copy(from: string, to: string): void {
		this.moveOrCopy(from, to, false);
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
				if (i >= a.length) ops.push({ op: 'add', path: child, value: b[i] });
				else if (i >= b.length) ops.push({ op: 'remove', path: child, value: a[i] });
				else this.diffNode(a[i], b[i], child, ops);
			}
		} else if (isPlainObject(a) && isPlainObject(b)) {
			const ao = a as Record<string, JsonValue>;
			const bo = b as Record<string, JsonValue>;
			const allKeys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
			for (const key of allKeys) {
				const child = `${path}['${key}']`;
				if (!(key in ao)) ops.push({ op: 'add', path: child, value: bo[key] });
				else if (!(key in bo)) ops.push({ op: 'remove', path: child, value: ao[key] });
				else this.diffNode(ao[key], bo[key], child, ops);
			}
		} else if (a !== b) {
			// Covers: same-type primitives with different values, and type changes
			// (e.g. object → array). In both cases there's nothing to recurse into.
			ops.push({ op: 'replace', path, oldValue: a, value: b });
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

	private getAt(segments: (string | number)[], source: any = this.base): any {
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
		if (segments.length === 0) { this.base = value as T; return; }
		// basically, for every segment except the last, we try to access the next level.
		// if it doesn't exist, we create an object or array depending on the next segment type.
		// so for example, if we have segments ['a', 'b', 'c', 0, 'd'], we first check if base['a'] exists.
		// If not, we create it as an object (since the next segment is 'b').
		// Given that we've had to create b, we don't need to check to see if the rest exist as we know they don't
		// so we can just create them all in one go.
		// So C is created as an array since the next segment is an index
		// And then at that index we create the object 
		console.log(segments);
		let current: any = this.base;
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
		this.pushOperation({ undo: undoUpsert, redo: doUpsert });
	}

	// Finds the deepest existing prefix of `segments` — the point upsertAt
	// needs to snapshot, because anything past it will be fabricated by setAt.
	private findRestorePoint(segments: (string | number)[]): {
		segments: (string | number)[];
		existed: boolean;
		oldValue: any;
	} {
		if (segments.length === 0) {
			return { segments, existed: true, oldValue: structuredClone(this.base) };
		}
		let current: any = this.base;
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
		if (segments.length === 0) { this.base = value as T; return; }
		let current: any = this.base;
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
		let current: any = this.base;
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
		return paths(this.base, jsonPath);
	}
}

// Test
const engine = new Engine<any>({ a: { b: 3 } });
engine.add('$.a.b.c[0].d', 5);
console.log(engine.base);
console.log(engine.base.a.b.c[0].d);
engine.add('$.a.b', 3);
console.log(engine.base);
engine.add('$.a.b', []);
engine.add('$.a.b[0]', 2);
engine.add('$.a.b[0]', 1);
engine.add('$.a.b[0]', 0);
console.log(engine.base);
engine.move('$.a.b[1]', '$.a.c');
console.log(engine.base);
engine.copy('$.a.c', '$.a.b[*]');
console.log(engine.base);
engine.undo();
console.log(engine.base);
engine.undo();
console.log(engine.base);
