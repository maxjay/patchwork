# restore() lifecycle: identity conflicts and stale paths

> **Status: open design question.** This document describes a confirmed bug and the
> surrounding design space. It is a prerequisite to any fix — the correct behaviour
> in each scenario needs to be agreed before implementation begins.

---

## Background

The engine has two independent mechanisms for undoing changes:

**`undo()` / `redo()`** — closure-based, LIFO. Every mutation pushes an `Operation`
onto `undoStack`. Each operation carries its own `undo` and `redo` closures, which
capture the exact values and indices at mutation time. The stack is walked in reverse;
you cannot selectively undo an earlier operation without first undoing everything after it.

**`restore(op: DiffOp)`** — diff-op-based. Takes a single `DiffOp` (as returned by
`diff()`) and applies its structural inverse to `draft`. This is the "undo a specific
visible change" primitive: the UI calls `diff()`, presents the result, and lets the user
click "undo" on any individual row. It does not touch `undoStack` — it is a forward
mutation that itself becomes undoable.

The two mechanisms are independent. `undo()` is always safe because it uses captured
closures. `restore()` is path-sensitive: it uses the paths stored in the `DiffOp`, which
were computed at `diff()` time and may be stale by the time `restore()` is called.

---

## The bug

### Reproduction

```ts
const engine = new Engine(
  { items: [{ id: 'A', name: 'Original' }, { id: 'B' }] },
  { schema } // items keyed by 'id'
);

// 1. Remove the element with identity 'A'
engine.delete('$.items[0]');
// draft: [{ id: 'B' }]

// 2. Capture the Remove diff op (e.g. to show an "undo" button in the UI)
const [removeOp] = engine.diff();
// removeOp = { op: 'remove', path: "$['items'][0]", identity: 'A', value: { id: 'A', name: 'Original' } }

// 3. Add a new element with the same identity — valid, since 'A' no longer exists
engine.add('$.items[1]', { id: 'A', name: 'New' });
// draft: [{ id: 'B' }, { id: 'A', name: 'New' }]

// 4. User clicks "undo remove" — restore() is called with the captured op
engine.restore(removeOp);
// restore(Remove) calls: this.add("$['items'][0]", { id: 'A', name: 'Original' })
// draft: [{ id: 'A', name: 'Original' }, { id: 'B' }, { id: 'A', name: 'New' }]
//         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^
//         re-inserted at index 0                       still present
```

**Result:** two elements sharing identity `'A'` coexist in `draft`. The keyed-array
invariant — that identity uniquely identifies an element within an array — is broken.

### Why it happens

`restore(Remove)` is implemented as a direct `this.add(op.path, op.value)`. It splices
the old value back at the index the op recorded. It has no knowledge of:

- Whether another element with the same identity now exists at a different position
- Whether the array has shifted since `diff()` was called, making `op.path` point to a
  different slot than intended

The `Remove` op carries `identity` precisely for tracking purposes, but `restore()` does
not use it.

---

## What `undo()` does instead (and why it's safe)

`undo()` uses closure-captured state, not diff-op paths. The undo closure for a `delete`
captures the exact value AND the splice function bound to the array reference at mutation
time. It does not re-resolve a path string.

```
Remove A  → undo: () => splice A back at position 0
Add A_new → undo: () => splice out the element at position 1
```

Calling `undo()` twice (in LIFO order) correctly reverses both mutations without conflict.
There is no ambiguity because closures capture the intent at mutation time.

**Limitation:** LIFO-only. You cannot undo the remove without first undoing the add.
This is why `restore()` exists — to give the UI selective, non-LIFO undo.

---

## Adjacent issues

### 1. Stale path index without identity collision

Even without a duplicate-identity scenario, `restore()` can act on a stale index.

```
// Start: [A, B, C]   (keyed by id)
// Remove B at index 1 → diff: Remove(B, path: items[1])
// Add D at index 0   → draft: [D, A, C]  (indices shifted)
// restore(Remove(B)) → inserts B at items[1] → [D, B, A, C]
```

B ends up at index 1, which was its original base position. But the intent was to undo
the removal — where should it go? In an unordered keyed array, position is arbitrary.
In an ordered keyed array, "where it was in base" may or may not be right depending on
what other changes have happened.

This isn't a correctness bug for unordered arrays (position doesn't matter), but it is
semantically wrong for ordered arrays where displacement is meaningful.

### 2. restore(Replace) with stale index

`restore(Replace)` calls `this.replace(op.path, op.oldValue)`. The path is the draft
index at `diff()` time. If the element has moved since (via add/remove elsewhere in the
array), `op.path` now points to a different element and the wrong value gets replaced.

For identity-keyed arrays this is fixable: look up the element by identity to get the
current path, then replace. For non-keyed arrays there is no identity to look up.

### 3. restore(Add) with stale index

`restore(Add)` calls `this.delete(op.path)`. If the added element has moved (due to
other inserts/removes), `op.path` deletes the wrong element. Same problem as above.

---

## The two-primitive tension

| | `undo()` | `restore()` |
|---|---|---|
| Mechanism | Closure (captures exact state) | Path resolution (stale risk) |
| Order | LIFO only | Any order |
| Identity-aware | N/A (raw array ops) | Has identity field, doesn't use it |
| State validity | Always consistent | Can break keyed-array invariant |
| Undo stack | Pops from undoStack | Pushes new op onto undoStack |

The core tension: `restore()` needs to be non-LIFO (that's the entire point), but
non-LIFO reversal of a state-changing operation is only safe if the engine knows the
current relationship between the stale op and the current draft.

---

## Scenarios and expected outcomes (open questions)

The following scenarios each need a defined correct behaviour before any fix can be written.

### S1: restore(Remove) — identity already exists in draft

```
base:  [A, B]      draft: [B, A_new]     removeOp: Remove(identity=A)
```

Options:
- **Replace**: replace the existing `A_new` with `Original A`. Net effect: the new
  element is discarded and the base element is restored. Conceptually clean — "undo the
  remove" means "put the original back, regardless of what's there."
- **Reject**: throw / return a conflict error. Force the caller to resolve before
  restoring. Safe but shifts responsibility to the consumer.
- **Prepend/append**: insert Original A alongside A_new, producing the duplicate. This
  is the current behaviour — universally wrong for keyed arrays.
- **No-op**: if a same-identity element exists, skip the restore silently. Prevents the
  duplicate but hides a logic error.

### S2: restore(Add) — identity no longer exists in draft

```
base:  [B]         draft: [B]            addOp: Add(identity=A)
```
(Someone already removed A_new before the restore was called.)

Options:
- **No-op**: A is already gone; the Add has effectively already been undone. Silent.
- **Throw**: the op is stale; error.

### S3: restore(Replace) — element has moved

```
base:  [A, B]      draft: [B, A_modified]     replaceOp: Replace(path: items[0], oldValue: A_original)
```
(A was modified then the array shifted.)

Options:
- **Identity lookup**: find A by its `identity` field in the current draft, get its
  current path, then replace at that path.
- **Path as-is**: replace at `items[0]` — hits B, wrong element.

---

## What we know for certain

1. The duplicate bug (S1, current behaviour) is always wrong and must be fixed.
2. `undo()` (LIFO, closure-based) is correct as-is; no changes needed there.
3. `restore()` for non-keyed arrays (no `identity` on the op) has no identity-conflict
   risk; only the stale-index issue applies.
4. For keyed arrays, `restore()` should use `identity` to locate the element in the
   current draft, not the raw path index.
5. The `identity` field already exists on `Remove`, `Add`, `Replace`, `Move`, and
   `Unchanged` ops — the information is present; `restore()` just doesn't consult it.
