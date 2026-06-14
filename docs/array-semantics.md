# Array semantics: identity, ordering, and the diff API

> **Status: specification.** This document is the authoritative design reference for the array
> diff API. It supersedes the earlier 0.13–0.16 approach (filter-string identity
> paths, `Seg` / `canonicalizeSegs` / `resolveCanonical` layer), which was abandoned, and
> replaces the previous draft of this document. Nothing here is yet implemented.

---

## Motivation

This spec extends `diff()` on the engine to understand array identity and ordering. The result
is a single API with one option that covers both use cases:

```ts
engine.diff(path?, options?)
// options.includeUnchanged: false (default) — only changed elements
// options.includeUnchanged: true            — all elements, including unchanged
// options.cascade:          true  (default) — changes in nested identity arrays bubble up to parent
// options.cascade:          false           — identity containment; parent reflects direct fields only
```

The default behaviour — changes only — is for programmatic inspection: what was added, removed,
or modified. Passing `includeUnchanged: true` is for UI rendering: the consumer gets every
element with a state label and can render the full list from a single call without zipping
against the raw array.

Both are snapshot comparisons between `base` and `draft`, independent of the undo stack.

The primary use case is a UI where an array has been edited and you want to show the user —
clearly and accurately — what was added, modified, kept the same, and removed. And you want to
give the user a way to individually revert any of those changes without the consuming code having
to implement the inverse logic itself.

---

## Core concepts

### x-key: element identity

Every keyed array declares an `x-key` — the field that uniquely identifies each element. This is
the addressing device for the diff: instead of comparing elements by position, the engine pairs
them across `base` and `draft` by identity.

`x-key` can be:
- A field name: `x-key: 'id'` — the `id` field of each object element is its identity
- `$self` — the item itself is its identity; for primitive arrays where values are unique and
  meaningful (tags, permission names, status flags)

Without `x-key`, arrays are diffed positionally (index-zip). This is correct for tuples and
fixed-position arrays, wrong for almost everything else.

### Ordered vs unordered

Every keyed array is declared as either **ordered** or **unordered**. This is a declaration about
what the data means — not something the engine infers.

**Unordered** — the array is a collection. Position carries no meaning. Removing element B does
not change anything about element C; C's new index is noise. The diff reports only membership
changes: what was added, removed, or modified.

**Ordered** — the array is a sequence. Position is meaningful. Removing element B shifts C to a
new index, and that shift is real — C's position in the sequence changed. This is surfaced as
**displacement** (see §State labels). Displacement only ever appears in ordered arrays.

The distinction matters for the consumer. An unordered diff gives you clean, actionable changes:
add, remove, modify. An ordered diff gives you the same, plus a signal that something moved
that the consumer may want to surface to the user — even if that movement cannot be individually
undone.

### Identity stability

If the field that `x-key` points to changes value, the diff sees the original element as removed
and a new element as added. This is the defined behavior — it falls out naturally from snapshot
matching, which pairs elements by identity. When an identity changes, no match exists; the differ
sees one element gone and one new element appear.

This is by design. Identity is declared precisely because it is the slice of an element that
does not change when you edit everything else. If the identity field changes, it is a different
element by definition. Consumers should treat identity fields as semantically stable — mutating
one is valid at the engine level, but the diff will report it as remove + add, not modify.

---

## Declaration

```json
{
  "type": "array",
  "x-key": "id",
  "x-ordered": true,
  "items": { "type": "object" }
}
```

- `x-key` — the identity field. Required for identity-based diffing.
- `x-ordered` — boolean. `true` = ordered (displacement is surfaced). Absent or `false` =
  unordered (displacement is invisible).

> `x-ordered` is a placeholder name pending a final decision on the keyword.

For primitive arrays, `x-key: '$self'` means the value itself is the identity. Combined with
`x-ordered: true`, reorders are visible as displacement. Without `x-ordered`, position is
meaningless and reorders are invisible.

---

## State labels

Every element entry carries a `state` and a `displacement`. These are two independent axes:

- `state` describes what happened to the **value** of the element
- `displacement` describes what happened to the **position** of the element

Because they are independent, an element can be both `modified` (fields changed) and displaced
(position shifted) at the same time. These are not contradictory — they describe different
things.

### `unchanged`
The element exists in both `base` and `draft` with the same identity, the same field values,
and (in ordered arrays) the same position. Nothing about it changed. Included in the `includeUnchanged` path
so the consumer can render the full list; excluded from the diff API.

### `added`
The element exists in `draft` but not in `base`. It is new. Has no `baseValue` or `baseIndex`.
`displacement` is always 0 for added elements.

### `removed`
The element exists in `base` but not in `draft`. It was deleted. Has no `value` or `index`.
`displacement` is always 0 for removed elements. Still included in the `includeUnchanged` path so the consumer
can render it as a removed row.

### `modified`
The element exists in both `base` and `draft` with the same identity, but its field values
differ. Carries a `changes` array of field-level DiffOps (see §Field-level changes).

If the element also moved position, `displacement` will be non-zero — the element is
simultaneously modified and displaced. Check `displacement !== 0` to know.

### `displaced`
The element exists in both `base` and `draft` with the same identity and identical field values,
but at a different index. Its value did not change. Its position did.

`state: 'displaced'` is used when position changed and value did not. When both changed,
`state` is `'modified'` and `displacement` is non-zero — `displaced` as a state label is
reserved for the position-only case.

Displacement only appears in ordered arrays. In an unordered array, removing B shifts C up, but
C is `unchanged` — its position is irrelevant.

**Displacement is revertible.** Restore moves the element back to `baseIndex`. This shifts other
elements (cascade), which is expected and correct — `diff()` recomputes from the new
snapshot, and any new or resolved displacements appear there.

---

## The ArrayEntry type

```ts
type ArrayEntry = {
  identity: JsonValue;
  value?: JsonValue;       // current draft value; absent when state === 'removed'
  baseValue?: JsonValue;   // base value; absent when state === 'added'
  state: 'unchanged' | 'added' | 'removed' | 'modified' | 'displaced';
  index?: number;          // current index in draft; absent when state === 'removed'
  baseIndex?: number;      // index in base; absent when state === 'added'
  displacement: number;    // 0 = no shift; positive = shifted later; negative = shifted earlier
  changes?: DiffOp[];      // field-level diffs; present when state === 'modified'
};
```

`displacement` is always present on ordered-array entries. On unordered-array entries it is
always 0 (or absent — TBD on whether to omit it).

`changes` is present only when `state === 'modified'`. When state is `modified` and
`displacement !== 0`, the element is both modified and displaced; `changes` describes the field
changes and `displacement` describes the position shift.

---

## Field-level changes

When an element is `modified`, `changes` carries the field-level diff as a flat `DiffOp[]`.
Paths are relative to the element root (`$`).

**Example:** element `{ id: 1, title: 'Fix bug', tags: ['urgent', 'backend'] }` changed to
`{ id: 1, title: 'Fix bugs', tags: ['urgent', 'frontend'] }`:

```ts
changes: [
  { op: 'replace', path: "$['title']",   oldValue: 'Fix bug',  value: 'Fix bugs'  },
  { op: 'remove',  path: "$['tags'][1]", value: 'backend' },
  { op: 'add',     path: "$['tags'][1]", value: 'frontend' },
]
```

### Changes is flat, not recursive

If an element contains a nested array with its own `x-key`, that nested array's changes appear
as flat DiffOps in `changes` — not as nested `ArrayEntry` items.

The rationale: if you need identity-aware semantics on a nested array, rescope your engine to
that path and run `diff()` on it directly. Recursive nesting in `changes` produces a
mixed, hard-to-type structure and pushes the consumer deeper into the document than this API is
designed to go. The flat boundary is intentional.

The one caveat is nested arrays without `x-key`. Their change paths in `changes` are positional
(e.g. `$['tags'][1]`). These paths are correct at diff time but may be stale if further
mutations occur on those arrays before restore is called. Declaring `x-key` on any nested array
you care about removes this concern.

---

## Displacement: detailed treatment

### What it means

An element is displaced when its identity-matched counterpart lands at a different index in
`draft` than it had in `base`. Something moved it — either an add or remove of a nearby element,
or a deliberate repositioning by the user.

The spec makes **no distinction** between "passively displaced by a nearby change" and
"deliberately moved by the user." At snapshot level, both produce the same result: same identity,
same fields, different index. Both are `displaced`. If that distinction matters to the consumer,
it is not resolvable from the diff alone.

### The displacement value

`displacement` is the integer delta: `index - baseIndex`.

- `0` — no displacement (or unordered array)
- `+2` — shifted two positions later in the sequence
- `-1` — shifted one position earlier

This lets a UI render "moved from position 2 to position 3" without computing it.

### Cancellation: when add and remove balance out

Adding one element and removing one element at equivalent positions produces zero net
displacement for surrounding elements. Two adds produce two units of displacement. Two removes
produce two units in the opposite direction. They are additive and can cancel.

**Example:** base `[A, B, C]` (ordered). Remove B (base index 1), add D at draft index 1.

Draft: `[A, D, C]`

| element | base index | draft index | displacement | state |
|---|---|---|---|---|
| A | 0 | 0 | 0 | unchanged |
| B | 1 | — | — | removed |
| D | — | 1 | — | added |
| C | 2 | 2 | 0 | unchanged |

C is not displaced. The removal of B would have pulled C forward by one, but the addition of D
at the same position pushed it back. Net delta: zero. C is `unchanged`.

### Cascade on restore

Restoring a displaced element moves it back to `baseIndex`, which shifts other elements. That
shift may create new displacements, or resolve existing ones. This is correct — the arrays
semantics handle it naturally. The items/diff API recomputes from the new snapshot.

---

## Restore

> **Note:** "Restore" is the working name for the operation that inverts a diff entry. The final
> method name is not yet decided. This is distinct from the engine's existing `revert` method,
> which operates on the undo stack. Restore operates on diff output — it is the user-facing
> "undo this change" action.

Restore takes a diff entry (or a specific change within it) and applies the inverse mutation to
the draft, returning the element or field to its base state. It is designed to be used in
combination with `diff()`: diff an array, identify an entry you want to undo, restore
it.

### Per-state semantics

| state | displacement | restore operation |
|---|---|---|
| `added` | 0 | delete the element |
| `removed` | 0 | insert `baseValue` at `baseIndex` |
| `modified` | 0 | replace element with `baseValue` |
| `displaced` | ≠ 0 | move element from current `index` to `baseIndex` |
| `modified` | ≠ 0 | replace element with `baseValue`, then move to `baseIndex` |
| `unchanged` | 0 | no-op |

For the `modified` + displaced case: restore fields first (replace with `baseValue` at current
position), then move to `baseIndex`. Order matters — replace targets the current position; move
happens after.

### Sub-change restore

For `modified` elements, restore can operate at field granularity — inverting a single DiffOp
from `changes` rather than replacing the whole element. This lets the user undo "just this field"
while leaving other field changes in place.

Inverse of each DiffOp kind:

| op in `changes` | inverse operation |
|---|---|
| `replace` (path, oldValue, value) | replace at path with `oldValue` |
| `add` (path, value) | delete at path |
| `remove` (path, value) | add at path with `value` |

### Identity as address — path stability

Restore addresses elements by identity, not by position. The consumer never needs to know or
track the current positional path of an element. The engine locates the element in the current
draft internally using the declared `x-key`.

For sub-change restore, the engine:
1. Finds the element in the current draft by identity
2. Joins the element's current internal path with the relative `changes` path
3. Applies the inverse operation

From the consumer's perspective: identity and the change entry are the only inputs. The element
may have moved since the diff was computed — that does not matter, because identity is the
address, not position.

This dissolves the path staleness problem that plagued the earlier approach. Path staleness
cannot happen here because positional paths were never the addressing mechanism. An element's
index is a rendering detail, not an identity.

**The only exception** is nested arrays without `x-key` in `changes`. Their paths are
positional and may be stale if further mutations occur between diff and restore. The fix is
always to declare `x-key`.

---

## Worked examples

### Example 1: ordered array, remove and restore

Base: `[A, B, C]` (ordered, x-key on each element)

Step 1 — remove B:

| element | state | displacement |
|---|---|---|
| A | unchanged | 0 |
| B | removed | — |
| C | displaced | -1 |

Step 2 — add D at index 1, restore B (insert at base index 1):

Draft: `[A, B, D, C]`

| element | state | displacement |
|---|---|---|
| A | unchanged | 0 |
| B | unchanged | 0 |
| D | added | — |
| C | displaced | +1 |

C was at base index 2, is now at draft index 3. D's insertion before it caused this. C cannot
be individually restored to index 2 without also removing or moving D.

### Example 2: field modify + displacement together

Base: `[{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }]` (ordered, x-key: 'id')

Operations: remove element 1 (Alpha), change element 2's name to 'Beta v2'.

Draft: `[{ id: 2, name: 'Beta v2' }]`

| element | state | displacement | changes |
|---|---|---|---|
| id=1 | removed | — | — |
| id=2 | modified | -1 | `[{ op: 'replace', path: "$['name']", oldValue: 'Beta', value: 'Beta v2' }]` |

Element 2 is simultaneously `modified` (name changed) and displaced (moved from index 1 to
index 0). One entry, both facts. Restore: replace element with `baseValue`, then move to
`baseIndex: 1`.

---

## Design decisions: what was considered and rejected

### Reason field on displaced entries

Earlier versions of this spec proposed a `reason` field on displaced entries, pointing at the
specific add or remove that caused the displacement. Dropped. Attribution logic is complex
(partial attribution when multiple operations cancel, representation of composite reasons), and
consumers do not need it for the core use cases. Displacement is surfaced; its cause is
derivable by inspection if needed.

### Recursive `changes`

Considered making `changes` recursive — nested arrays with `x-key` inside a modified element
would produce nested `ArrayEntry` items rather than flat DiffOps. Dropped. The type becomes a
mixed structure, the consumer API becomes harder to consume, and the right answer when you need
identity-aware semantics on a nested array is to rescope the engine to that path and call the
items/diff API there.

### Filter-string identity paths (0.13–0.16 approach)

The previous implementation encoded identity as JSONPath filter strings and built a
segment/canonicalize/resolve layer (`Seg`, `canonicalizeSegs`, `resolveCanonical`) to maintain
stable references to elements across mutations. Abandoned. That machinery existed to solve path
staleness — the problem that an element's positional path becomes wrong after nearby insertions
or deletions. This spec dissolves the problem rather than solving it: identity is the address,
position is never the address. Path staleness cannot occur when paths are never used as identity.

### "Effect" as the word for displacement

The original draft used "effect" for what is now "displaced." Rejected. "Effect" is vague.
"Displaced" is precise — it describes exactly what happened to the element's position.

### `state` as an array to support combined states

Considered making `state` an array (e.g. `['modified', 'displaced']`) to allow both labels
simultaneously. Rejected in favour of: `state` is the primary value-change label (`'modified'`),
and `displacement !== 0` signals position change as an orthogonal axis. The combined case is
readable — check both. An array type for state is unusual and adds type-handling burden.

### Folding displacement into `modified`

Considered representing position change on a modified element as a note within the `modified`
entry, rather than surfacing `displacement` as a separate axis. Rejected: displacement is
meaningful on otherwise-unchanged elements too (`state: 'displaced'`). Treating it as a modifier
of `modified` would hide it in the pure-displacement case.

---

## Deferred / open

- **`x-ordered` final keyword name** — placeholder, not decided.
- **Restore final method name** — "restore" is the working name; not decided.
- **Composite and nested-path identity** — `x-key` as a simple field name only. Nested paths
  (`meta.id`) and composite keys (two or more fields together) are deferred.
- **In-place ordered arrays** — a third array kind where removal keeps the slot (no gap-closing,
  no displacement cascade). Concept understood; build later.
- **Repeatable ordered sequences** — sequences that may contain duplicate values cannot use
  `$self` as identity (value collision). Synthetic per-element IDs are needed. Deferred.
- **Deliberate reorder as distinct from passive displacement** — currently both produce
  `displaced`, indistinguishably. Whether to surface "this element was explicitly moved" is not
  yet decided.
- **`diff()` exact method signature** — the full options shape and how `includeUnchanged` interacts
  with the existing `key` option on `Engine` and `NodeEngine` is not yet specified.
- **Interaction with existing `diff()` method** — how the existing `diff()` on the engine
  relates to the new items and diff APIs. Not yet specified.
- **`displacement` on unordered entries** — whether to include it as always-0 or omit it. Not
  yet decided.
