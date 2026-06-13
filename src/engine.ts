import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';
import {
	type Seg,
	canonicalizeSegs,
	ghostInsertIndex,
	identityOf,
	isPlainObject,
	isUnderPrefix,
	joinPath,
	patternChild,
	patternElement,
	rebasePath,
	resolveCanonical,
	segmentsToPattern,
	segsToPath,
} from './paths.js';

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
	| { op: OpType.Add;     path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
	| { op: OpType.Replace; path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue; identity?: JsonValue }
	| { op: OpType.Remove;  path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
	| { op: OpType.Move | OpType.Copy; from: string; to: string }
	| { op: OpType.Revert; path: string; absolutePath?: string };

// One element of the merged identity view returned by items(). Pure data,
// so the view is JSON-serializable as-is.
export type ItemEntry<V extends JsonValue = JsonValue> = {
	// The x-key value (or the item itself under x-key: '$self'). The data
	// handle — use it for list tracking and display.
	identity: JsonValue;
	// The action handle: engine-built canonical identity path for this
	// element, e.g. $['users'][?@['email'] == "b@x.com"]. Feeds straight into
	// delete/replace/get/getBase; resolves to the live item in draft, the
	// ghost in base, never a different element. Never an index — it can't go
	// stale when the array is spliced.
	path: string;
	// Absent for unchanged items.
	op?: OpType.Add | OpType.Remove | OpType.Replace;
	// The draft item — or the base item when op is Remove (the ghost content).
	value: V;
	// Field-level ops for Replace entries. Paths are relative to the item
	// ($['region']), with identity filters for any nested keyed arrays.
	changes?: DiffOp[];
	// Replace entries only. selfChanged: at least one change is on this item's
	// own field. descendantsChanged: at least one change descends into a nested
	// keyed element (it carries an identity). Both can be true. Lets a tree UI
	// tell "this node was edited" from "this node only contains edited children".
	// Note: a change to a $self set field on the item counts as descendantsChanged
	// (a $self set is itself a keyed array).
	selfChanged?: boolean;
	descendantsChanged?: boolean;
};

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
			for (const [p, k] of extractKeyMap(sub as Record<string, any>, patternChild(path, key)))
				map.set(p, k);
		}
	}
	if (schema.items && isPlainObject(schema.items)) {
		for (const [p, k] of extractKeyMap(schema.items as Record<string, any>, patternElement(path)))
			map.set(p, k);
	}
	return map;
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

	// Same as get() but reads from base instead of draft.
	getBase(jsonPath: string): Array<{ path: string; value: JsonValue }> {
		const matched = paths(this.base, jsonPath);
		return matched.map(p => ({
			path: p,
			value: this.getAt(this.segmentsFrom(p), this.base),
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

	// Same as getValue() but reads from base instead of draft.
	getValueBase(jsonPath: string): JsonValue {
		const matched = paths(this.base, jsonPath);
		if (matched.length > 1) {
			throw new Error(`getValueBase: path resolved to ${matched.length} values, expected exactly one`);
		}
		if (matched.length === 0) {
			throw undefined;
		}
		return this.getAt(this.segmentsFrom(matched[0]), this.base);
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

	// Detects the [-] append sentinel at the end of a path and replaces it with
	// the current length of the target array, making the path point just past
	// the last element. If the array doesn't exist yet, resolves to [0] so
	// that upsertAt can create it.
	private resolveAppendSentinel(jsonPath: string): string {
		if (!jsonPath.endsWith('[-]')) return jsonPath;
		const parentPath = jsonPath.slice(0, -3);
		const matched = paths(this.draft, parentPath);
		if (matched.length !== 1) return `${parentPath}[0]`;
		const arr = this.getAt(this.segmentsFrom(matched[0]));
		return `${parentPath}[${Array.isArray(arr) ? arr.length : 0}]`;
	}

	add(jsonPath: string, value: any): void {
		jsonPath = this.resolveAppendSentinel(jsonPath);
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

	// Pushes the inverse of pending changes at the path onto the stack as a
	// new operation — history is never rewritten.
	//
	// Targets are collected from both draft and base and canonicalized against
	// the side they resolved from: inside keyed arrays this is what keeps the
	// base-frame and draft-frame occupants of the same index from colliding
	// into one target (the index-application bug that used to clobber
	// neighbors when reverting a removed element). Everything is captured
	// eagerly — concrete positions and cloned values — like every other op;
	// the stack's LIFO discipline guarantees redo replays from the same state.
	revert(jsonPath: string): void {
		const targets = new Map<string, Seg[]>();
		for (const p of paths(this.draft, jsonPath)) {
			const canon = canonicalizeSegs(this.draft, this.keyMap, this.segmentsFrom(p));
			targets.set(segsToPath(canon), canon);
		}
		for (const p of paths(this.base, jsonPath)) {
			const canon = canonicalizeSegs(this.base, this.keyMap, this.segmentsFrom(p));
			targets.set(segsToPath(canon), canon);
		}

		// Three kinds of work, applied as: sets (no index shifts), then removals
		// in reverse index order, then re-insertions at positions planned against
		// the post-removal sequence. Undo mirrors the same lists in reverse.
		const sets: Array<{ segments: (string | number)[]; oldValue: any; value: any }> = [];
		const removals: Array<{ segments: (string | number)[]; oldValue: any }> = [];
		const ghosts: Array<{ canon: Seg[]; value: any; baseIndex: number }> = [];

		for (const canon of targets.values()) {
			const baseSegs = resolveCanonical(this.base, canon);
			const draftSegs = resolveCanonical(this.draft, canon);
			if (baseSegs === undefined && draftSegs !== undefined) {
				// draft-only: a pending add — take it out
				removals.push({ segments: draftSegs, oldValue: structuredClone(this.getAt(draftSegs)) });
				continue;
			}
			if (baseSegs === undefined) continue; // in neither — nothing to revert
			const value = structuredClone(this.getAt(baseSegs, this.base));
			const last = canon[canon.length - 1];
			if (draftSegs !== undefined) {
				// in both: restore the base value in place
				sets.push({ segments: draftSegs, oldValue: structuredClone(this.getAt(draftSegs)), value });
			} else if (typeof last === 'object') {
				// a removed keyed element: re-insert (position planned below)
				ghosts.push({ canon, value, baseIndex: baseSegs[baseSegs.length - 1] as number });
			} else {
				// a deleted field under a surviving node: resolve the longest prefix
				// that still exists in draft and create the remainder literally. If
				// the remainder crosses an identity segment, the keyed element itself
				// is gone — reverting the element is the right tool — so skip.
				for (let i = canon.length - 1; i >= 0; i--) {
					const prefix = resolveCanonical(this.draft, canon.slice(0, i));
					if (prefix === undefined) continue;
					const rest = canon.slice(i);
					if (!rest.some(s => typeof s === 'object')) {
						const segments = [...prefix, ...(rest as (string | number)[])];
						sets.push({ segments, oldValue: structuredClone(this.getAt(segments)), value });
					}
					break;
				}
			}
		}

		// Plan ghost positions against the identity sequence each array will
		// have after the removals run, in ascending base order so earlier
		// restores anchor later ones.
		ghosts.sort((x, y) => x.baseIndex - y.baseIndex);
		const insertions: Array<{ segments: (string | number)[]; value: any }> = [];
		const arrays = new Map<string, { segments: (string | number)[]; sequence: Array<JsonValue | undefined> }>();
		for (const ghost of ghosts) {
			const seg = ghost.canon[ghost.canon.length - 1];
			if (typeof seg !== 'object') continue;
			const parentCanon = ghost.canon.slice(0, -1);
			const parentKey = segsToPath(parentCanon);
			let arr = arrays.get(parentKey);
			if (!arr) {
				const segments = resolveCanonical(this.draft, parentCanon);
				const draftArr = segments === undefined ? undefined : this.getAt(segments);
				if (segments === undefined || !Array.isArray(draftArr)) continue;
				const removedIdx = new Set(removals
					.filter(r => r.segments.length === segments.length + 1 &&
						typeof r.segments[segments.length] === 'number' &&
						segments.every((s, i) => r.segments[i] === s))
					.map(r => r.segments[segments.length] as number));
				const sequence = draftArr
					.filter((_, i) => !removedIdx.has(i))
					.map(item => identityOf(item, seg.key));
				arr = { segments, sequence };
				arrays.set(parentKey, arr);
			}
			const parentBaseSegs = resolveCanonical(this.base, parentCanon);
			const baseArr = parentBaseSegs === undefined ? undefined : this.getAt(parentBaseSegs, this.base);
			const idx = Array.isArray(baseArr) ? ghostInsertIndex(baseArr, arr.sequence, seg) : arr.sequence.length;
			arr.sequence.splice(idx, 0, seg.value);
			insertions.push({ segments: [...arr.segments, idx], value: ghost.value });
		}

		const doRevert = () => {
			for (const t of sets) this.setAt(t.segments, structuredClone(t.value));
			// Reverse to preserve array indices when removing multiple elements
			for (let i = removals.length - 1; i >= 0; i--) this.removeAt(removals[i].segments);
			for (const t of insertions) this.insertAt(t.segments, structuredClone(t.value));
		};

		const undoRevert = () => {
			for (let i = insertions.length - 1; i >= 0; i--) this.removeAt(insertions[i].segments);
			// Forward order to preserve array indices when restoring multiple elements
			for (const t of removals) this.insertAt(t.segments, structuredClone(t.oldValue));
			for (const t of sets) {
				if (t.oldValue === undefined) this.removeAt(t.segments);
				else this.setAt(t.segments, structuredClone(t.oldValue));
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
				// Store the override in pattern form, since the walk looks keys up
				// by pattern. A path resolving inside one array element therefore
				// keys all sibling elements' arrays for this call — acceptable for
				// a one-off override.
				const pattern = segmentsToPattern(this.segmentsFrom(resolved));
				const saved = this.keyMap;
				this.keyMap = new Map([...this.keyMap, [pattern, options.key]]);
				try { return this._diff(path); }
				finally { this.keyMap = saved; }
			}
		}
		return this._diff(path);
	}

	private _diff(path?: string): DiffOp[] {
		const ops: DiffOp[] = [];
		this.diffNode(this.base, this.draft, [], '$', ops);
		if (!path) return ops;
		// Ops carry canonical paths (identity segments inside keyed arrays), so
		// the resolved scope prefixes must be canonicalized against the document
		// they were resolved from before the string prefix-match. Note: scoping
		// by *index* into a keyed array matches both the base and draft occupant
		// of that slot — index scoping is inherently ambiguous there; scope by
		// identity filter for precision.
		const prefixes = [...new Set([
			...paths(this.draft, path).map(p => this.canonicalizePath(p, this.draft)),
			...paths(this.base, path).map(p => this.canonicalizePath(p, this.base)),
		])];
		return ops.filter(op => prefixes.some(p => isUnderPrefix(opPath(op), p)));
	}

	// Converts a concrete index path (as returned by paths()) into canonical
	// form: positions inside keyed arrays become identity segments, read off
	// the element in `doc`. Object keys and unkeyed indexes pass through.
	/** @internal */
	canonicalizePath(concretePath: string, doc: JsonValue): string {
		return segsToPath(canonicalizeSegs(doc, this.keyMap, this.segmentsFrom(concretePath)));
	}

	// Merged identity view of a keyed array — the read model a list UI needs.
	// Returns the union of base and draft elements matched by identity, each
	// labelled with the op that describes its state:
	//
	//   (no op)  unchanged
	//   add      present in draft only
	//   remove   present in base only — value carries the base item (ghost)
	//   replace  present in both with differences — changes carries the
	//            field-level ops, paths relative to the item
	//
	// Requires an identity key: x-key from the schema, or options.key inline.
	// Draft items come first in draft order, then removed items in base order.
	items<V extends JsonValue = JsonValue>(arrayPath: string, options?: { key?: string }): ItemEntry<V>[] {
		const resolved = [...new Set([...paths(this.draft, arrayPath), ...paths(this.base, arrayPath)])];
		if (resolved.length !== 1) {
			throw new Error(`items: path must resolve to exactly one array, got ${resolved.length}`);
		}
		const normPath = resolved[0];
		const segs = this.segmentsFrom(normPath);
		const pattern = segmentsToPattern(segs);
		const key = options?.key ?? this.keyMap.get(pattern);
		if (!key) {
			throw new Error(`items: no identity key for ${normPath} — declare 'x-key' in the schema or pass options.key`);
		}
		const baseVal = this.getAt(segs, this.base);
		const draftVal = this.getAt(segs, this.draft);
		if (!Array.isArray(baseVal) && !Array.isArray(draftVal)) {
			throw new Error(`items: ${normPath} is not an array in draft or base`);
		}
		const a = Array.isArray(baseVal) ? baseVal : [];
		const b = Array.isArray(draftVal) ? draftVal : [];

		// Entry paths are canonical: the prefix up to the array is canonicalized
		// against the side the array resolved on, then the element's identity
		// segment is appended — same serializer, same dialect as diff() output.
		const canonSegs = canonicalizeSegs(Array.isArray(draftVal) ? this.draft : this.base, this.keyMap, segs);

		if (key === '$self') return this.itemsBySelf(a, b, canonSegs) as ItemEntry<V>[];

		const aMap = this.buildIdentityMap(a, key, segs);
		const bMap = this.buildIdentityMap(b, key, segs);
		const pathOf = (id: JsonValue) => segsToPath([...canonSegs, { key, value: id }]);

		const entries: ItemEntry[] = [];
		for (const [id, item] of bMap) {
			if (!aMap.has(id)) {
				entries.push({ identity: id, path: pathOf(id), op: OpType.Add, value: item });
				continue;
			}
			// Item-relative diff: segments start fresh at the item (so paths come
			// out as $['region']) while the pattern stays document-rooted so
			// nested x-keys keep resolving.
			const ops: DiffOp[] = [];
			this.diffNode(aMap.get(id)!, item, [], patternElement(pattern), ops);
			if (ops.length === 0) {
				entries.push({ identity: id, path: pathOf(id), value: item });
			} else {
				// A change carries an identity iff it descends into a nested keyed
				// element (the item-relative diff above starts with no identity, so
				// own-field ops have none). That splits the changes cleanly.
				const descendantsChanged = ops.some(o => 'identity' in o && o.identity !== undefined);
				const selfChanged = ops.some(o => !('identity' in o) || o.identity === undefined);
				entries.push({ identity: id, path: pathOf(id), op: OpType.Replace, value: item, changes: ops, selfChanged, descendantsChanged });
			}
		}
		for (const [id, item] of aMap) {
			if (!bMap.has(id)) entries.push({ identity: id, path: pathOf(id), op: OpType.Remove, value: item });
		}
		return entries as ItemEntry<V>[];
	}

	// $self variant: the item is its own identity. Set semantics — duplicates
	// collapse, reorders are invisible, and replace can never occur because
	// equal primitives are the same set member. Same primitive-only restriction
	// as diffArrayBySelf, for the same reason (reference equality on objects).
	private itemsBySelf(a: JsonValue[], b: JsonValue[], canonSegs: Seg[]): ItemEntry[] {
		for (const arr of [a, b]) {
			for (const item of arr) {
				if (item !== null && typeof item === 'object') {
					throw new Error(
						`items: x-key '$self' at ${segsToPath(canonSegs)} requires primitive items, got ` +
						`${Array.isArray(item) ? 'array' : 'object'}. ` +
						`Use x-key: '<field>' for arrays of objects.`
					);
				}
			}
		}
		const pathOf = (item: JsonValue) => segsToPath([...canonSegs, { key: null, value: item }]);
		const aSet = new Set(a);
		const entries: ItemEntry[] = [];
		const seen = new Set<JsonValue>();
		for (const item of b) {
			if (seen.has(item)) continue;
			seen.add(item);
			if (aSet.has(item)) entries.push({ identity: item, path: pathOf(item), value: item });
			else entries.push({ identity: item, path: pathOf(item), op: OpType.Add, value: item });
		}
		for (const item of aSet) {
			if (!seen.has(item)) entries.push({ identity: item, path: pathOf(item), op: OpType.Remove, value: item });
		}
		return entries;
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
		segs: Seg[], pattern: string, key: string, ops: DiffOp[]
	): void {
		const aMap = this.buildIdentityMap(a, key, segs);
		const bMap = this.buildIdentityMap(b, key, segs);

		for (const [id, item] of aMap)
			if (!bMap.has(id)) ops.push({ op: OpType.Remove, path: segsToPath([...segs, { key, value: id }]), value: item, identity: id });

		for (const [id, item] of bMap)
			if (!aMap.has(id)) ops.push({ op: OpType.Add, path: segsToPath([...segs, { key, value: id }]), value: item, identity: id });

		for (const [id, bItem] of bMap)
			if (aMap.has(id)) this.diffNode(aMap.get(id)!, bItem, [...segs, { key, value: id }], patternElement(pattern), ops, id);
	}

	// Builds identity → item for one side of a keyed array, enforcing the
	// contract x-key declares: every item is an object carrying a primitive
	// identity, and identities are unique. Violations used to collapse
	// silently in a Map and produce quietly wrong diffs — now they throw.
	private buildIdentityMap(arr: JsonValue[], key: string, segs: Seg[]): Map<JsonValue, JsonValue> {
		const map = new Map<JsonValue, JsonValue>();
		for (const item of arr) {
			const id = identityOf(item, key);
			if (id === undefined || (id !== null && typeof id === 'object')) {
				throw new Error(
					`diff: item in keyed array at ${segsToPath(segs)} has no primitive '${key}' identity`
				);
			}
			if (map.has(id)) {
				throw new Error(
					`diff: duplicate identity ${JSON.stringify(id)} for key '${key}' in array at ${segsToPath(segs)}`
				);
			}
			map.set(id, item);
		}
		return map;
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
		segs: Seg[], ops: DiffOp[]
	): void {
		for (const arr of [a, b]) {
			for (const item of arr) {
				if (item !== null && typeof item === 'object') {
					throw new Error(
						`diff: x-key '$self' at ${segsToPath(segs)} requires primitive items, got ` +
						`${Array.isArray(item) ? 'array' : 'object'}. ` +
						`Use x-key: '<field>' for arrays of objects. See #18.`
					);
				}
			}
		}
		// Sets, not maps: $self declares set semantics, so duplicates collapse
		// by design rather than erroring like keyed arrays do.
		const aSet = new Set(a);
		const bSet = new Set(b);

		for (const item of aSet)
			if (!bSet.has(item)) ops.push({ op: OpType.Remove, path: segsToPath([...segs, { key: null, value: item }]), value: item, identity: item });

		for (const item of bSet)
			if (!aSet.has(item)) ops.push({ op: OpType.Add, path: segsToPath([...segs, { key: null, value: item }]), value: item, identity: item });
	}

	// `segs` is the canonical address of the node pair (identity segments
	// inside keyed arrays); `pattern` is the same location in keyMap form
	// (every array hop is [*]) for x-key lookups.
	private diffNode(a: JsonValue, b: JsonValue, segs: Seg[], pattern: string, ops: DiffOp[], identity?: JsonValue): void {
		if (Array.isArray(a) && Array.isArray(b)) {
			const key = this.keyMap.get(pattern);
			if (key === '$self') { this.diffArrayBySelf(a, b, segs, ops); return; }
			// diffArrayByKey stamps its own identity per item, so outer identity is not forwarded
			if (key) { this.diffArrayByKey(a, b, segs, pattern, key, ops); return; }
			const maxLen = Math.max(a.length, b.length);
			for (let i = 0; i < maxLen; i++) {
				const child = [...segs, i];
				if (i >= a.length) ops.push({ op: OpType.Add, path: segsToPath(child), value: b[i], ...(identity !== undefined && { identity }) });
				else if (i >= b.length) ops.push({ op: OpType.Remove, path: segsToPath(child), value: a[i], ...(identity !== undefined && { identity }) });
				else this.diffNode(a[i], b[i], child, patternElement(pattern), ops, identity);
			}
		} else if (isPlainObject(a) && isPlainObject(b)) {
			const ao = a as Record<string, JsonValue>;
			const bo = b as Record<string, JsonValue>;
			const allKeys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
			for (const key of allKeys) {
				const child = [...segs, key];
				if (!(key in ao)) ops.push({ op: OpType.Add, path: segsToPath(child), value: bo[key], ...(identity !== undefined && { identity }) });
				else if (!(key in bo)) ops.push({ op: OpType.Remove, path: segsToPath(child), value: ao[key], ...(identity !== undefined && { identity }) });
				else this.diffNode(ao[key], bo[key], child, patternChild(pattern, key), ops, identity);
			}
		} else if (a !== b) {
			// Covers: same-type primitives with different values, and type changes
			// (e.g. object → array). In both cases there's nothing to recurse into.
			ops.push({ op: OpType.Replace, path: segsToPath(segs), oldValue: a, value: b, ...(identity !== undefined && { identity }) });
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

	getBase(jsonPath: string): Array<{ path: string; value: JsonValue }> {
		return this.parent.getBase(joinPath(this.prefix, jsonPath))
			.map(r => ({ path: rebasePath(r.path, this.prefix), value: r.value }));
	}

	getValue(jsonPath: string): JsonValue {
		return this.parent.getValue(joinPath(this.prefix, jsonPath));
	}

	getValueBase(jsonPath: string): JsonValue {
		return this.parent.getValueBase(joinPath(this.prefix, jsonPath));
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
		// Ops carry canonical paths (identity segments inside keyed arrays), so
		// the lens prefix must be canonicalized the same way before matching.
		// Done per call — the identity occupying an index can change between calls.
		const canonicalPrefix = this.parent.canonicalizePath(this.prefix, this.parent.draft);
		return this.parent.diff(
			path ? joinPath(this.prefix, path) : undefined,
			options,
		)
			.filter(op => isUnderPrefix(opPath(op), canonicalPrefix))
			.map(op => {
				const rebased = rebaseDiffOp(op, canonicalPrefix);
				if ('path' in rebased) return { ...rebased, absolutePath: (op as any).path };
				return rebased;
			});
	}

	// Identity view — the array path joins into the parent frame, and entry
	// paths come back rebased into the child frame so they feed straight into
	// this lens's own ops (same canonical-prefix handling as diff()).
	items<V extends JsonValue = JsonValue>(arrayPath: string, options?: { key?: string }): ItemEntry<V>[] {
		const canonicalPrefix = this.parent.canonicalizePath(this.prefix, this.parent.draft);
		return this.parent.items<V>(joinPath(this.prefix, arrayPath), options)
			.map(entry => ({ ...entry, path: rebasePath(entry.path, canonicalPrefix) }));
	}

	// Nested children compose by joining paths and creating a fresh lens
	// against the same root parent.
	getNodeEngine<U extends JsonValue = JsonValue>(jsonPath: string): NodeEngine<U> {
		return this.parent.getNodeEngine<U>(joinPath(this.prefix, jsonPath));
	}
}
