# Engine internals

A deep reference for patchwork's `Engine` and `NodeEngine`. This covers the design decisions, the semantics of each operation, how things interact, and the edge cases that matter.

---

## The base/draft model

Every `Engine` holds exactly two views of the same document:

- **`base`** — the committed source of truth. Represents the last accepted state.
- **`draft`** — the working copy. All mutations land here.

On construction, both are independent deep clones of the value you pass in. They start identical and diverge as you mutate the draft.

```ts
const engine = new Engine({ x: 1 });
engine.base; // { x: 1 }
engine.draft; // { x: 1 }  — a separate object in memory

engine.replace('$.x', 2);
engine.draft; // { x: 2 }
engine.base;  // { x: 1 }  — untouched
```

`base` moves in exactly two situations:

1. `accept()` — snapshots a clone of `draft` into `base`.
2. `undo()` / `redo()` of a previous `accept()` — restores the snapshot taken at that time.

Everything else — `replace`, `delete`, `add`, `move`, `copy`, `revert`, and even `decline` — only touches `draft`. `base` is inert to mutations.

### Why two views?

The split is the fundamental primitive that lets patchwork compose several concerns cleanly:

- `diff()` compares `base` against `draft` to produce a change list — no need to track deltas manually.
- `decline()` resets draft to base in one step — no need to undo each change individually.
- Accepting is a human-controlled checkpoint — the engine can't commit itself.
- NodeEngine scoped accepts work because `base` and `draft` are separate objects that can be partially updated without touching the other.

---

## The undo stack

Every mutating operation pushes an `Operation` onto a private `undoStack`. Each `Operation` carries two closures: `undo` and `redo`. These closures capture everything needed to reverse or replay — old values, original segments, whether a container was an array, etc.

```
undoStack = [ op1, op2, op3 ]   ← push end is the "top"
redoStack = []
```

Calling `undo()` pops from `undoStack`, calls `op.undo()`, and pushes the operation onto `redoStack`:

```
undoStack = [ op1, op2 ]
redoStack = [ op3 ]
```

Calling `redo()` pops from `redoStack`, calls `op.redo()`, and pushes back onto `undoStack`.

**Any new mutation clears `redoStack`.** History is linear — once you branch from a previous state, the redo path is discarded.

### What goes on the stack

Every call to `add`, `replace`, `delete`, `move`, `copy`, `revert`, `accept`, and `decline` pushes one operation. `exportChanges` filters these to the ones that carry a `DiffOp` descriptor — structural mutations only, not accepts/declines.

### Stack items vs diff

The undo stack and `diff()` are completely independent. If you `replace` a value five times then `undo()` five times, the stack empties and `diff()` returns `[]`. The undo stack records *how you got here*; `diff()` describes *where you are* relative to base.

---

## Mutations in depth

### `add(path, value)`

`add` has two modes depending on whether the path resolves to something in the current draft:

**On an existing array element** — the value is *spliced* into the array at that index, shifting elements right. This is array-insert semantics, not overwrite.

```ts
engine = new Engine({ items: ['a', 'b', 'c'] });
engine.add('$.items[1]', 'x');
engine.draft.items; // ['a', 'x', 'b', 'c']
```

**On an existing object key** — sets the value at that key, overwriting what was there.

**On a path that doesn't exist yet** — if the path is a literal (no wildcards, filters, or descendant selectors), the engine *creates* the missing path. Intermediate objects and arrays are fabricated based on the type of the next segment: a numeric next segment means an array is created, anything else means an object.

```ts
engine = new Engine({});
engine.add('$.a.b.c', 42);
engine.draft; // { a: { b: { c: 42 } } }

engine.add('$.list[0]', 'first');
engine.draft; // { a: { b: { c: 42 } }, list: ['first'] }
```

If the path is a query (wildcard, filter, slice, descendant) and nothing matches, `add` is a no-op. It can't create nodes via query selectors.

Undo of an array insert removes the element (splices it back out). Undo of an object set restores the previous value at that key.

### `replace(path, value)`

Overwrites the value(s) at path. Unlike `add`, no splicing — it's always a set. Supports wildcards: `replace('$.items[*].enabled', false)` sets `enabled` on every item.

The undo closure captures the old value at each matched path before the write, and restores each one individually.

### `delete(path)`

Removes the node at path. For arrays, splices the element out (shifts subsequent elements left). For objects, uses `delete obj[key]`.

Wildcards work: `delete('$.items[?@.archived]')` removes all archived items. Deletions happen in reverse index order to preserve index validity during multi-element array removal.

Undo of an array delete re-splices the element back at its original index. Undo of an object delete re-sets the key.

### `move(from, to)`

Copies the value at `from` to `to`, then removes `from`. `from` must resolve to exactly one node — ambiguous or multi-match is an error. Moving a path into one of its own descendants is also an error (the source would be gone before the destination is set).

If `from` and `to` resolve to the same path, the operation is a no-op.

### `copy(from, to)`

Like `move` but leaves the source in place. Same single-source constraint.

### `revert(path)`

Resets `draft` at `path` to whatever `base` has there. More nuanced than it looks:

- The set of paths to touch is the union of paths resolved against `draft` and paths resolved against `base`. This covers: nodes present in draft but removed in base (they should be deleted in draft), and nodes present in base but added in draft (they should be restored in draft).
- Wildcards work: `revert('$.items[*].color')` resets the color of every item back to its base value.
- If base has no value at the path, the draft node is removed.
- If draft has no value at the path, a clone of the base value is inserted.

---

## Reading values

### `get(path)`

Returns `Array<{ path: string; value: JsonValue }>` — every node in `draft` that matches the expression, paired with its normalized path. Returns `[]` when nothing matches; never throws.

The returned paths are in normalized form (`$['key'][0]`) and are guaranteed to resolve to exactly one node. You can feed them straight into `replace`, `delete`, etc.

```ts
engine.get('$.servers[*]');
// [
//   { path: "$['servers'][0]", value: { host: 'a' } },
//   { path: "$['servers'][1]", value: { host: 'b' } },
// ]
```

### `getValue(path)`

Strict single-match read. Throws an `Error` if the path resolves to more than one node (ambiguous). Throws the literal value `undefined` if nothing resolves — this allows `try/catch` with `catch (e) { if (e === undefined) … }` to distinguish "no value" from an actual error.

Designed for binding to a single field. If you need multi-match, use `get`.

### `getBase(path)` and `getValueBase(path)`

Exact mirrors of `get` and `getValue` that read from `base` instead of `draft`. Same return shapes, same throw semantics.

Useful when you need to query the committed state with full JSONPath expressiveness — wildcards, filters, recursive descent — without dropping down to `engine.base` and navigating manually.

```ts
engine.replace('$.items[0].label', 'new label');

engine.get('$.items[*].label');      // ['new label', 'b', 'c']  — draft
engine.getBase('$.items[*].label');  // ['old label', 'b', 'c']  — committed

engine.getValue('$.items[0].label');      // 'new label'
engine.getValueBase('$.items[0].label');  // 'old label'
```

After `accept()`, `base` matches `draft` and both pairs return the same values. Both methods are also available on `NodeEngine`, reading from the parent's base subtree with paths rebased to the child frame.

---

## `diff()` in depth

`diff()` compares `base` against `draft` and returns a flat list of `DiffOp` objects describing every structural difference. It's a **snapshot comparison** — it doesn't know or care about the undo stack. If you replace a value ten times and end up at the original, `diff()` returns `[]`.

### DiffOp anatomy

```ts
type DiffOp =
  | { op: 'add';           path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
  | { op: 'replace';       path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue; identity?: JsonValue }
  | { op: 'remove';        path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
  | { op: 'move' | 'copy'; from: string; to: string }
  | { op: 'revert';        path: string; absolutePath?: string }
```

- **`path`** — normalized JSONPath (`$['key'][0]`). Inside identity-keyed arrays, a *canonical identity path*: the element segment is an RFC 9535 filter on the key — `$['users'][?@['email'] == "b@x.com"]` — instead of an index. An index cannot address keyed elements coherently (a removed element only has a position in base, an added one only in draft); an identity path names the same element against either document and can be fed back into `replace` / `delete` / `get` / `revert`. Identity paths are valid RFC 9535 queries the engine evaluates natively, though formally not RFC "Normalized Paths" (the RFC's output grammar cannot express identity).
- **`absolutePath`** — only present on ops from `NodeEngine.diff()`. The full document path while `path` is relative to the child's `$`.
- **`identity`** — present on `add` / `remove` ops produced by identity-keyed diffing. The matched key value (or the primitive item itself for `$self`). Not set on field-level `replace` ops or on index-zip ops. This is what lets consumers identify *which element* was added or removed without needing to know the schema's key field.
- **`oldValue`** — present on `replace` ops. The value that was at the path in base before the change.
- **`value`** — the new value for `add` / `replace`; the removed value for `remove`.

### How the walk works

`diff()` walks `base` and `draft` in parallel, recursing into matching structure:

**Plain objects** — union all keys across both sides. Key only in `draft` → `add`. Key only in `base` → `remove`. Key in both → recurse.

**Arrays** — depends on the declared identity mode (see below).

**Everything else** — if the values differ (strict equality, `!==`), emit `replace`. This covers same-type primitives with different values, and type mismatches (e.g., object→array). Recursion stops here — there's nothing to descend into.

### Scoped diff

Pass a JSONPath to filter the results:

```ts
engine.diff('$.server');     // ops under $.server only
engine.diff('$.items[*]');   // ops under any array element
```

The path is resolved against both `base` and `draft` so that ops for deleted nodes (not in draft) and added nodes (not in base) are both included. Each resolved prefix is canonicalized — positions inside keyed arrays become identity filters, read off the element on the side it resolved from — and the filter keeps only ops whose (canonical) path falls under one of the prefixes.

Scoping by identity filter (`$.users[?@.email == 'c@x.com']`) is precise. Scoping by *index* into a keyed array (`$.users[1]`) matches both the base and draft occupants of that slot — index scoping is inherently ambiguous there.

---

## Array diffing modes

Arrays in JSON are polymorphic — they mean different things depending on context. Patchwork supports three distinct modes; which one fires depends on what you've declared for that array.

### Mode 1: Index-zip (default)

When no identity is declared, arrays are diffed position by position up to the longer length.

```
base:  [a, b, c]
draft: [b, c]        ← 'a' was deleted from the front
```

Index-zip output:
```
replace [0]: a → b
replace [1]: b → c
remove  [2]: c
```

This is semantically wrong for an element-identity scenario — every surviving element is flagged as changed, and the real operation (delete `a`) is completely obscured. But it is *correct* for fixed-structure arrays where the position is the meaning: `[lat, lng]`, `[r, g, b]`, `[first, rest...]`.

Use index-zip when the index *is* the identity. In all other cases, declare an identity.

### Mode 2: Identity-keyed (`x-key: '<field>'`)

Declare `x-key` on a schema array node. The engine matches elements across `base` and `draft` by the value of that field.

```ts
const engine = new Engine(data, {
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        'x-key': 'id',
        items: { type: 'object' },
      },
    },
  },
});
```

After `extractKeyMap` walks the schema, the engine knows that the array at `$['items']` uses `'id'` as its key. During `diffNode`, when it encounters an array at a location that matches, it dispatches to `diffArrayByKey`.

`diffArrayByKey` builds two `Map<keyValue, item>` — one for each side — then:

1. Any key in base but not draft → `remove` op at the element's identity path (with `identity: keyValue`).
2. Any key in draft but not base → `add` op at the element's identity path (with `identity: keyValue`).
3. Any key in both → recurse into the pair with `diffNode`, with the identity segment as the path prefix.

This means changes *within* a surviving element (a field rename, a nested value update) are represented as granular field-level ops — `$['items'][?@['id'] == 7]['v']` — not as a wholesale remove+add of the element.

**Strictness** — `x-key` is a contract: every item is an object carrying a primitive value under the key, unique within the array. `diff()` throws on duplicate or missing identities. (Before this, violations collapsed silently in the maps and produced a quietly wrong diff.)

**Nested arrays** — `x-key` composes. If an array item itself contains an array with its own key, declare `x-key` on that inner schema too. The walk carries the location in *pattern form* (every array hop is `[*]`, e.g. `$['groups'][*]['members']`) and looks that up in the key map, so a single schema registration covers all elements. The pattern is built from segments, never by rewriting path strings.

**Per-call override** — no schema needed if you use the `key` option directly:

```ts
engine.diff('$.items', { key: 'id' });
```

This injects a temporary key mapping for the duration of that single `diff()` call.

### Mode 3: Set semantics (`x-key: '$self'`)

For arrays where the items are the identity — tag lists, permission names, status flags — use `'$self'` as the key. The item itself is treated as its identity.

```ts
schema: {
  permissions: {
    type: 'array',
    'x-key': '$self',
    items: { type: 'string' },
  },
}
```

The algorithm is pure set difference using JavaScript's native `Set` (which provides value-equality for primitives):

- Items in base but not draft → `remove` ops at `[?@ == item]` (with `identity: item`).
- Items in draft but not base → `add` ops at `[?@ == item]` (with `identity: item`).
- Reordering is invisible — this is set semantics, and sets have no order.
- Duplicates collapse — if both sides contain duplicate `'urgent'`, the set deduplicates them and the net diff is empty. (Unlike keyed arrays, duplicates are *not* an error here: `$self` declares set semantics, and collapse is what sets do.)

**Restricted to primitive items.** JavaScript's `Set` uses reference equality for objects, so `{a:1}` and `{a:1}` would be treated as different identities. If you attempt `$self` on an array containing objects or nested arrays, `diff()` throws with a message pointing to `x-key: '<field>'`. Extending `$self` to structural identity for objects (via canonical-JSON normalization or deep-equal scan) is tracked separately.

### Identity paths

When identity-keyed diffing is active, no op carries an index into the keyed array — every element segment is an identity filter. Two ops can never claim the same path while meaning different elements, paths never go stale when the array is spliced, and any emitted path can be fed back into `replace` / `delete` / `get` / `revert` to address exactly the element it described. The `identity` field carries the matched key value as plain data so consumers don't parse it out of the path.

(Index paths fundamentally cannot work here: a removed element only has a position in base, an added one only in draft, so any index emission mixes two coordinate systems in one op list — earlier versions did exactly that.)

---

## Ephemeral sessions

An ephemeral session lets you batch an arbitrary sequence of mutations into one logical undo entry.

```ts
engine.beginEphemeral();
// ... many mutations
engine.commitEphemeral();  // or discardEphemeral()
```

**How it works internally:** `beginEphemeral` records the current `undoStack.length` as the session start marker. All subsequent mutations push onto the stack normally. `commitEphemeral` splices those entries out, builds one composite `Operation` whose `undo` calls each sub-operation's undo in reverse, and `redo` calls each in forward order, then pushes that single composed operation.

`discardEphemeral` also splices those entries out but immediately calls each sub-operation's undo in reverse — unwinding all changes — then clears `redoStack` to prevent replaying them.

Within an active session, `undo()` works on individual steps but cannot step before the session boundary — the engine pins the stack pointer at the session start. This means you can preview individual intermediate states without accidentally reaching pre-session history.

Nested sessions are not supported; `beginEphemeral` throws if one is already open.

**When to use it:**

- **Streaming LLM output** — call `beginEphemeral` before the first chunk, `replace` the target field on each chunk, `commitEphemeral` when the stream ends. The user sees live updates but has one undo entry.
- **Hover preview** — `beginEphemeral`, apply a preview, render. On mouse-out: `discardEphemeral`.
- **Form input binding** — `beginEphemeral` on focus, `replace` on every keystroke, `commitEphemeral` on blur. One undo entry per field, not one per character.

---

## NodeEngine: scoped lenses

`getNodeEngine(path)` returns a `NodeEngine<U>` — a zero-copy lens rooted at a subtree of the parent. It holds no state of its own, only a reference to the parent and a prefix path.

```ts
const engine = new Engine({
  cars:   [{ color: 'red' }],
  trucks: [{ color: 'green' }],
});

const cars = engine.getNodeEngine('$.cars');
```

### State sharing

Reads on `cars` resolve through `engine` on every access — if `engine.draft.cars` is reassigned, `cars.draft` reflects it immediately. Writes from `cars` forward to `engine.add` / `engine.replace` etc., with the prefix joined to the child path.

```ts
cars.replace('$[0].color', 'blue');
// calls engine.replace("$['cars'][0].color", 'blue') internally
```

**Mutations through either side are visible in both.** There is one physical document.

### Path rewriting

`NodeEngine` rewrites paths in both directions:

- **Outbound (child → parent):** `joinPath(prefix, childPath)` strips the leading `$` from the child path and concatenates it onto the prefix.
- **Inbound (parent → child):** `rebasePath(fullPath, prefix)` strips the prefix from the full path and prepends `$`.

This means `cars.get('$[*].color')` calls `engine.get("$['cars'][*].color")` and then rebases the returned paths from `$['cars'][0]['color']` to `$[0]['color']`.

### Subtree-scoped `accept` and `decline`

`cars.accept()` replaces only the cars subtree of `engine.base` with a clone of the cars subtree of `engine.draft`. The trucks subtree of `engine.base` is untouched. This uses `setOnTarget` — a low-level helper that navigates to the parent object and sets the final segment without touching anything else.

The operation is pushed onto the parent's undo stack (as everything is), so `engine.undo()` reverses a subtree accept.

### `diff` on a lens

`cars.diff()` calls `engine.diff()` with no scope filter, then:

1. Filters to ops whose path falls under the `cars` prefix.
2. Rebases each op's path from the full document path to the child frame (`$['cars'][0]` → `$[0]`).
3. Attaches `absolutePath` to each op carrying the original full-document path.

This means the lens's `diff()` output is self-contained for the subtree, but callers that need document-level paths can read `absolutePath` without re-joining.

### Composing lenses

`cars.getNodeEngine('$[0]')` creates a further-scoped lens rooted at the first car, joined against the same root parent. Paths compose transitively — the grandchild's writes end up at `$['cars'][0][...]` in the parent.

---

## Export and import

### `exportChanges()`

Returns `DiffOp[]` from the undo stack — specifically, the `op` descriptor attached to each `Operation`. Only structural mutations (`add`, `replace`, `delete`, `move`, `copy`, `revert`) carry a descriptor; `accept`, `decline`, and ephemeral-session commits do not. Those are filtered out.

The result is the *recorded sequence of operations*, not the *diff*. If you replaced a field ten times, you get ten `replace` ops. If you want the net change, use `diff()`.

### `importChanges(ops)`

Replays a `DiffOp[]` stream by dispatching each op through the corresponding method. If any operation throws, all previously-applied operations are rolled back via `undo()` and the error is re-thrown wrapped with the index of the failing op.

This makes `importChanges` atomic at the transaction level — it either fully applies or leaves the engine exactly as it was.

**Round-trip:** `exportChanges` → transmit → `importChanges` reconstructs the same `draft` on any engine initialized with the same `base`. The `base` document is not included in the export and must be transmitted separately.

---

## JSONPath in detail

Patchwork uses [`jsonpath-rfc9535`](https://www.npmjs.com/package/jsonpath-rfc9535) which implements the full [RFC 9535](https://datatracker.ietf.org/doc/html/rfc9535) standard.

### Selectors

| Syntax | Semantics |
|---|---|
| `$.key` / `$['key']` | Named member. Both forms are equivalent. |
| `$[0]` / `$[-1]` | Index. Negative counts from the end. |
| `$[2:5]` | Slice `[start:end]`. End is exclusive. |
| `$[2:8:2]` | Slice with step `[start:end:step]`. |
| `$[*]` | All children of an object or array. |
| `$..*` | All descendants, recursively. |
| `$[?<expr>]` | Filter — elements for which the expression is truthy. |
| `$['a','b']` | Union — both `a` and `b`. |

Filter expressions use `@` to refer to the current node:

```
$[?@.enabled]              nodes with a truthy 'enabled' property
$[?@.count > 10]           nodes where count > 10
$[?@.type == 'admin']      nodes where type is exactly 'admin'
$[?@.tags[*] == 'urgent']  nodes with 'urgent' anywhere in their tags array
```

### Normalized paths

The `paths()` function from `jsonpath-rfc9535` always returns paths in a canonical form: every segment uses bracket notation with quotes for string keys and bare integers for indices — `$['server']['port']`, `$['items'][0]`. This form is what patchwork returns from `get()` and embeds in `DiffOp.path`.

Normalized paths are guaranteed to resolve to exactly one node and can be fed back into any mutating method.

### Query vs literal paths

Patchwork distinguishes between *literal* paths (every segment is a concrete key or index) and *query* paths (at least one segment is a wildcard, filter, slice, or descendant). The distinction matters for `add`:

- **Literal paths** — `add` creates missing intermediate nodes. `add('$.a.b.c', 1)` fabricates `a`, `b`, and `c` if needed.
- **Query paths** — `add` only operates on existing matches. If nothing matches, it's a no-op. You can't create nodes with a filter expression.

`replace`, `delete`, and `revert` always operate only on existing matches, so the distinction doesn't apply to them.

---

## Behavioral edges worth knowing

**`replace` at the root (`$`)** — replaces the entire draft with a new value. Works, but the undo closure captures the full old draft.

**`delete` with a wildcard on an array** — elements are removed in reverse index order to prevent index-shift errors during iteration. `delete('$.items[*]')` empties the array correctly.

**`revert` on an added key** — if the key exists in draft but not in base, revert removes it.

**`revert` on a deleted key** — if the key exists in base but not in draft, revert restores it.

**`move` self-to-self** — detected and short-circuited as a no-op. Nothing pushed to the stack.

**`importChanges` rollback** — if operation N fails, operations 0 through N-1 are individually undone in reverse. The engine is left in its pre-import state. The error message includes the failing index.

**Ephemeral + `undo()` at boundary** — `undo()` is a no-op at the session start marker. It cannot reach pre-session history while a session is open. This is intentional so that streaming previews can't accidentally rewind committed state.

**`NodeEngine` after subtree reassignment** — the child reads through the parent on every access, so it always reflects the current state of the parent even if the parent's subtree was completely replaced.

**`getValue` and `undefined`** — the "no match" signal is `throw undefined`. This is an unusual pattern but allows `catch (e) { if (e === undefined) handleMissing(); else throw e; }` to distinguish a missing value (normal, expected) from a real error (unexpected).
