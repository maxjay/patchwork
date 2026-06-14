# Implementation: array semantics

> **Status: implementation spec.** This document translates the array semantics design
> (`docs/array-semantics.md`) into engine-level implementation decisions, code structure,
> and pseudo-code. Read that document first.

---

## DiffOp type extensions

The existing union stays intact. Four additions:

```ts
export type DiffOp =
  // --- existing, unchanged ---
  | { op: OpType.Add;    path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
  | { op: OpType.Remove; path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
  | { op: OpType.Copy;   from: string; to: string }
  | { op: OpType.Revert; path: string; absolutePath?: string }

  // --- existing, extended ---
  // replace gains displacement and changes when it comes from a keyed array element.
  // leaf-level replaces (no identity) never carry these fields.
  | { op: OpType.Replace; path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue;
      identity?: JsonValue; displacement?: number; changes?: DiffOp[] }

  // move gains identity when it represents displacement of a keyed array element.
  // from = base path, to = draft path.
  | { op: OpType.Move; from: string; to: string; identity?: JsonValue }

  // --- new ---
  // unchanged: only emitted when options.includeUnchanged is true. Never appears in default diff().
  | { op: OpType.Unchanged; path: string; value: JsonValue; identity: JsonValue; displacement: number }
```

`OpType` gains one new member: `Unchanged = 'unchanged'`.

Rules:
- `identity` present on a `replace` → element-level op from a keyed array. `changes` holds the
  field-level diffs relative to the element root (`$`). `displacement` is the index delta
  (`draftIndex - baseIndex`); 0 if no position change.
- `identity` present on a `move` → pure displacement. `from` = `$[path][baseIndex]`,
  `to` = `$[path][draftIndex]`. No field changes on the element.
- `unchanged` → element exists in both base and draft with identical value. `displacement` is 0
  for unordered arrays; may be non-zero for ordered arrays (but if it is non-zero the element is
  displaced, not unchanged — so in practice `unchanged` always has `displacement: 0`; pure
  displacement goes through `move`).

---

## Schema parsing extension

`keyMap` currently maps path pattern → key string. It needs to also track whether each keyed
array is ordered. Rather than a parallel map, extend the map value:

```ts
// before
private keyMap: Map<string, string> = new Map();

// after
interface ArrayMeta { key: string; ordered: boolean }
private keyMap: Map<string, ArrayMeta> = new Map();
```

`extractKeyMap` follows the same recursive structure, extended:

```ts
function extractKeyMap(schema: Record<string, any>, path = '$'): Map<string, ArrayMeta> {
    const map = new Map<string, ArrayMeta>();
    if (schema['x-key']) {
        map.set(path, {
            key:     schema['x-key'] as string,
            ordered: schema['x-ordered'] === true,
        });
    }
    if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties))
            for (const [p, m] of extractKeyMap(sub as Record<string, any>, `${path}['${key}']`))
                map.set(p, m);
    }
    if (schema.items && isPlainObject(schema.items)) {
        for (const [p, m] of extractKeyMap(schema.items as Record<string, any>, `${path}[*]`))
            map.set(p, m);
    }
    return map;
}
```

All existing call sites that read `this.keyMap.get(path)` to get the key string change to
`.get(path)?.key`. The `ordered` flag is consumed only inside `diffArrayByKey`.

---

## Extending diffArrayByKey

This is where most of the new logic lives. The existing method handles add and remove correctly;
the matched-element branch (the third loop) is where displacement and grouping are added.

Current structure:

```ts
private diffArrayByKey(a, b, path, key, ops): void {
    const aMap = new Map(a.map((item, i) => [item[key], { item, i }]));
    const bMap = new Map(b.map((item, i) => [item[key], { item, i }]));

    // removed
    for (const [id, { item, i }] of aMap)
        if (!bMap.has(id)) ops.push({ op: Remove, path: `${path}[${i}]`, value: item, identity: id });

    // added
    for (const [id, { item, i }] of bMap)
        if (!aMap.has(id)) ops.push({ op: Add, path: `${path}[${i}]`, value: item, identity: id });

    // matched — currently just recurses into diffNode
    for (const [id, { item: bItem, i: bIndex }] of bMap)
        if (aMap.has(id)) this.diffNode(aMap.get(id)!.item, bItem, `${path}[${bIndex}]`, ops, id);
}
```

Extended structure — the matched branch becomes aware of displacement and field grouping:

```ts
private diffArrayByKey(a, b, path, key, ordered, ops, includeUnchanged): void {
    const aMap = new Map(a.map((item, i) => [item[key], { item, i }]));
    const bMap = new Map(b.map((item, i) => [item[key], { item, i }]));

    // removed — unchanged
    for (const [id, { item, i }] of aMap)
        if (!bMap.has(id)) ops.push({ op: Remove, path: `${path}[${i}]`, value: item, identity: id });

    // added — unchanged
    for (const [id, { item, i }] of bMap)
        if (!aMap.has(id)) ops.push({ op: Add, path: `${path}[${i}]`, value: item, identity: id });

    // matched
    for (const [id, { item: bItem, i: bIndex }] of bMap) {
        if (!aMap.has(id)) continue;
        const { item: aItem, i: aIndex } = aMap.get(id)!;
        const displacement = ordered ? bIndex - aIndex : 0;

        // collect field-level diffs by running diffNode into a fresh array
        const fieldOps: DiffOp[] = [];
        this.diffNode(aItem, bItem, '$', fieldOps);

        const fieldsChanged = fieldOps.length > 0;
        const displaced     = displacement !== 0;

        if (fieldsChanged) {
            ops.push({
                op: Replace,
                path:         `${path}[${bIndex}]`,
                identity:     id,
                value:        bItem,
                oldValue:     aItem,
                displacement,
                changes:      fieldOps,
            });
        } else if (displaced) {
            ops.push({
                op:   Move,
                from: `${path}[${aIndex}]`,
                to:   `${path}[${bIndex}]`,
                identity: id,
            });
        } else if (includeUnchanged) {
            ops.push({
                op:           Unchanged,
                path:         `${path}[${bIndex}]`,
                identity:     id,
                value:        bItem,
                displacement: 0,
            });
        }
    }
}
```

`ordered` and `includeUnchanged` are passed in from the call site in `diffNode`.

`diffNode`'s dispatch for arrays changes from:

```ts
if (key) { this.diffArrayByKey(a, b, path, key, ops); return; }
```

to:

```ts
if (key) {
    const meta = this.keyMap.get(path) ?? this.keyMap.get(toPathPattern(path));
    this.diffArrayByKey(a, b, path, meta.key, meta.ordered, ops, includeUnchanged);
    return;
}
```

`includeUnchanged` propagates down from the top-level call — `diff()` passes `false`,
`items()` passes `true`.

---

## diff() signature extension

`items()` is dropped. `diff()` gains two new options:

```ts
diff(path?: string, options?: {
  key?: string;
  includeUnchanged?: boolean;
  cascade?: boolean;
}): DiffOp[]
```

`includeUnchanged` defaults to `false` — existing behaviour, only changed ops returned.
Passing `true` includes `unchanged` ops for keyed array elements, giving the consumer the full
list for UI rendering without a separate method.

`cascade` defaults to `true` — existing behaviour, changes within nested identity-keyed arrays
bubble up and mark the parent element as `modified`. Passing `false` enables identity
containment: when `diffNode` is collecting `fieldOps` for a matched element and encounters a
nested array with `x-key` declared, it stops at that boundary rather than recursing into it.
The nested array owns its own diff; the parent's modification state reflects only its direct
fields. Consumer opts into containment explicitly — default preserves existing behaviour.

`_diff` passes `includeUnchanged` down through `diffNode` → `diffArrayByKey`. For non-array
paths and unkeyed arrays it has no effect — the existing `diffNode` logic only emits on change
and has no concept of `unchanged` to emit.

---

## Restore — path-based

The restore operation (name TBD, see spec) inverts a `DiffOp` produced by `diff()`.

**Restore uses paths directly.** The contract is: restore operates on a diff produced from the
current draft state. If the draft has been mutated since the diff was computed, the diff is stale
— re-diff before restoring. Given a fresh diff, paths in the ops are accurate by definition;
nothing has shifted since they were computed.

This means the inverse operations are straightforward:

| op | restore |
|---|---|
| `add` (path, value) | `engine.delete(op.path)` |
| `remove` (path, value) | `engine.add(op.path, op.value)` |
| `replace` (path, oldValue) | `engine.replace(op.path, op.oldValue)` |
| `move` (from, to) | `engine.move(op.to, op.from)` |

For `replace` with `changes` (modified element), sub-change restore inverts individual entries
in `changes`. Each `changes` path is relative to the element root — join with `op.path` to get
the full document path:

| change op | restore |
|---|---|
| `replace` (path, oldValue) | `engine.replace(join(op.path, change.path), change.oldValue)` |
| `add` (path, value) | `engine.delete(join(op.path, change.path))` |
| `remove` (path, value) | `engine.add(join(op.path, change.path), change.value)` |

---

## restore(op)

Takes a `DiffOp` produced by `diff()` and applies the inverse operation, pushing
a reversible entry onto the undo stack. Same closure pattern as every other mutating method.

Checking `op.op` directly is cleaner than re-deriving what changed by comparing base and draft —
the diff already did that work.

```ts
restore(op: DiffOp): void {
    switch (op.op) {
        case OpType.Add: {
            const segments    = this.segmentsFrom(op.path);
            const doRestore   = () => this.removeAt(segments);
            const undoRestore = () => this.insertAt(segments, structuredClone(op.value));
            doRestore();
            this.pushOperation({ undo: undoRestore, redo: doRestore });
            break;
        }
        case OpType.Remove: {
            const segments    = this.segmentsFrom(op.path);
            const doRestore   = () => this.insertAt(segments, structuredClone(op.value!));
            const undoRestore = () => this.removeAt(segments);
            doRestore();
            this.pushOperation({ undo: undoRestore, redo: doRestore });
            break;
        }
        case OpType.Replace: {
            const segments    = this.segmentsFrom(op.path);
            const doRestore   = () => this.setAt(segments, structuredClone(op.oldValue));
            const undoRestore = () => this.setAt(segments, structuredClone(op.value));
            doRestore();
            this.pushOperation({ undo: undoRestore, redo: doRestore });
            break;
        }
        case OpType.Move: {
            const fromSegs    = this.segmentsFrom(op.to);
            const toSegs      = this.segmentsFrom(op.from);
            const doRestore   = () => { this.insertAt(toSegs, structuredClone(this.getAt(fromSegs))); this.removeAt(fromSegs); };
            const undoRestore = () => { this.insertAt(fromSegs, structuredClone(this.getAt(toSegs))); this.removeAt(toSegs); };
            doRestore();
            this.pushOperation({ undo: undoRestore, redo: doRestore });
            break;
        }
    }
}

---

## Note: revert and path ordering

The existing `revert(jsonPath)` resolves the query against both base and draft, unions the
results, and processes each path in sequence. For field paths this is fine — `setAt` is a value
overwrite with no side effects on siblings. For array element paths, order matters: removing
index 1 shifts what is at index 2; processing index 2 afterwards hits the wrong element.

`revert` does not currently sort or reverse its path list before processing. This is a known
limitation. `restore` avoids the problem entirely by taking a single concrete path — no
multi-path resolution, no ordering concern.
