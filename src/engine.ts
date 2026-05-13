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
	undo: () => void;
	redo: () => void;
}

// A DiffOp describes a single structural difference between two JSON values,
// expressed as a JSONPath + the relevant values. Unlike Operation, it has no
// knowledge of history or how to reverse anything — it's purely descriptive.
export type DiffOp =
	| { op: 'add';     path: string; value: JsonValue }
	| { op: 'remove';  path: string; value: JsonValue }
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

	add(jsonPath: string, value: any): void {
		// const segments = this.segmentsFrom(jsonPath);
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		if (normalizedPaths.length === 0) {
			// treat as literal path to create if no matches
			// if the jsonPath contains any query selectors, throw an error
			// TODO - support this better
			if (jsonPath.includes('*')) {
				throw new Error(`Invalid JSONPath: ${jsonPath}`);
			}
			// e.g. 'a.b.c.d' creates { a: { b: { c: { d: value }}}}
			this.setAt(this.segmentsFrom(jsonPath), value);
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

	move(from: string, to: string): void {
	}

	copy(from: string, to: string): void {
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

	private getAt(segments: (string | number)[]): any {
		if (segments.length === 0) return this.base;
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		return current[segments[segments.length - 1]];
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
engine.add('$.a.b[0]', 1);
console.log(engine.base);