# Array semantics: unordered, ordered, in-place

> **Status: design reference.** We reset to 0.12.0 after concluding the 0.13–0.16
> approach (encoding identity as JSONPath *filter strings*, with a segment /
> canonicalize / resolve layer to build and re-resolve them) was weight the concept
> never needed — ergonomics ("make `delete(op.path)` work") bolted on instead of
> leveraging the machinery we already had. This doc is the reference we build the
> redesign against. Nothing here is implemented yet.

## What 0.12.0 keeps and drops

0.12.0 already matches array elements by **identity** (`x-key`) and stamps an
`identity` field on diff ops — those parts were right, and we keep them. What it
does *not* have, and what we are deliberately leaving behind: the filter-string
identity paths and the `Seg` / `canonicalizeSegs` / `resolveCanonical` apparatus.
The original index-path frame issue returns with 0.12.0; this design fixes it
properly rather than papering over it.

## First principles

1. **A key is an addressing device for the diff, nothing more.** It answers
   "which element is this?" by identity instead of position, so the differ can
   pair elements across `base` and `draft`. It is a *diff-time* concept; at rest
   the data is a plain JSON array. Identity may be a field (`a`), a nested path
   (`a.b.c`), a composite of several fields, or `$self` (the value itself) for
   primitives.

2. **Editing an element is a change to the element, not to the array.** The
   array holds a reference; the key is how the differ finds it. Field edits are
   the element's business. The array only cares about **membership** and, when
   ordered, **position**.

3. **Identity must be stable under edits.** It has to be the slice of the
   element that does not change when you edit the rest — which is why it is
   *declared*, never inferred. Structural / whole-value identity breaks the
   instant you edit, turning an edit into remove + add.

4. **Order shows up in the diff two ways, and only one is revertible.**
   - A **move** — an element changed its order *relative to the other surviving
     elements* (you dragged C in front of B). A real, user-made change.
     Revertible (move it back).
   - An **effect** — an element's absolute index shifted *only* because
     something else was added or removed near it; its order relative to the
     survivors is unchanged. The array cares about order, so this is real and is
     surfaced — but it is **not revertible on its own**. It carries a *reason*
     pointing at the entries that caused the shift; you revert the cause.

   Position is therefore never a free-standing "modification". It splits into
   `move` (revertible) and `effect` (consequence, not revertible).

## Entry kinds

The diff / items API labels **every** element with exactly one state:

| kind | typical colour | meaning | revertible? | extra |
|---|---|---|---|---|
| `unchanged` | — | identical, and didn't cross any survivor | n/a | |
| `add` | green | in draft, not base | yes — remove it | |
| `remove` | red | in base, not draft | yes — restore it | |
| `modify` | yellow | same element, fields differ | yes — restore fields | field-level changes |
| `move` | (own colour) | crossed another surviving element | yes — move back | from/to order |
| `effect` | muted | index shifted as a consequence of a nearby add/remove | **no** | `reason` → causing entries |

`move` and `effect` occur **only in ordered arrays**. Unordered arrays never
produce them.

> **One API, both views.** The API returns every element with its state —
> including `unchanged` and `effect` — so a consumer can render the **full draft
> list** (paint each row by its state) *or* a **changes-only summary** (filter to
> entries that represent a change) from the same dataset. The redesign's job is to
> define this data precisely; the UI decides what to show.

## The three kinds

### 1. Unordered array — a bag
Position is noise.

- **Diff**: `add` / `remove` / `modify` only — no `move`, no `effect`. Reorders
  and index shifts are invisible; removing B does not touch C in anything the
  diff records.
- **Revert**: restore membership; re-insert anywhere (append). Position is a
  non-question.
- Typical: tags, permissions, a collection of config objects keyed by id.

### 2. Ordered array — a sequence
Order is meaningful, so the diff records both *who moved* and *who was displaced*.

- **Diff**: `add` / `remove` / `modify`, **plus**
  - `move` — an element crossed another *surviving* element. Revertible.
  - `effect` — an element's index shifted because of an add/remove near it, its
    order relative to the survivors unchanged. Surfaced, but **not revertible**;
    its `reason` points at the causing add/remove entries.
- **Worked example** (the case that pinned this down): base `[A, B, C]`; remove
  B, add D where B was, restore B → `[A, B, D, C]`. Net vs base: **D added**
  (revertible); **C effected** — index 2→3, `reason` = the add of D, *not*
  revertible; A and B unchanged. C *has* changed (order matters), but you cannot
  revert C on its own — reverting D's add puts everything back.
- **Identity note**: an ordered sequence of *unique* values may use `$self`; one
  that may *repeat* values cannot (the value collides) and needs a real or
  synthetic per-element id.

### 3. In-place ordered array — fixed slots
Ordered, but removal **keeps the slot** instead of closing the gap.

- **Diff**: removing B vacates B's slot but does **not** shift C, D… so removal
  produces **no `effect` entries** — positions are fixed. (This is the key
  difference from §2: gap-closing produces effects; slot-keeping doesn't.)
- **Revert**: restore B into its still-reserved slot. Exact, no ripple.
- Open (deferred): what occupies a vacated slot (hole / null / tombstone),
  whether length is preserved, how "add into a hole" differs from "add new".

## Summary

| array kind | others' index shifts on add/remove | recorded as | genuine reorder |
|---|---|---|---|
| unordered | invisible | nothing | invisible |
| ordered (gap-closing) | real | `effect` (not revertible, has `reason`) | `move` (revertible) |
| ordered in-place | none (slot stays) | nothing | `move` (revertible) |

## Declaration (how the engine knows which)

- **Identity / key**: our `x-key` (field, nested path, or composite). `$self`
  for value-identity, which lines up with JSON Schema `uniqueItems: true` (a set
  of unique values) — adopt `uniqueItems` as the standard set signal where it
  fits; keep `x-key` as our extension for field/path identity, since JSON Schema
  has no native key concept.
- **Ordered vs unordered**: JSON Schema has no keyword for "this list's order is
  meaningful", so this is our own declaration — a boolean alongside the key.
  (`prefixItems` is the one positional case JSON Schema does express, for tuples.)
- **In-place**: a second boolean on an ordered array. Deferred.

## Prior art (why `effect`/`move` over an index cascade)

No RFC defines array *diff* semantics. **RFC 6902 (JSON Patch)** addresses array
elements by index and supplies the `move`/`copy` *vocabulary*, but it is a patch
format, not a diff — and many 6902 diff libraries emit only add/remove/replace.
The question "what is a change in a sequence" is owned by **Myers/LCS** (powers
`git diff` — LCS members are unchanged, the diff is insert/delete) and by
**sequence CRDTs** (Yjs, Automerge, RGA — each element has stable identity and a
position defined by between-ness of its neighbours; inserting near an element
does not modify it). Both treat "D inserted before C" as an insertion, not a
change to C. Our `effect` kind is the bridge: it lets an order-significant UI
*surface* that C was displaced (which pure LCS would hide) without pretending the
displacement is an independently revertible edit.

## Implementation stance (direction, not detailed design)

- **Drop the filter-string identity paths and the segment round-trip.** Identity
  stays a declared concept; the `identity` field carries it in output.
- **Express revert through the same functional `{ undo, redo }` closures** as the
  op stack — capture *what to restore* as a closure, don't re-derive locations
  from path strings. `effect` entries have **no revert closure by
  construction** — they cannot be reverted; the `reason` redirects to the cause.
- **Ordered diff** is computed two ways from the same pairing: *relative order of
  common identities* (LCS-flavoured) yields `move`; *absolute index delta* yields
  `effect`. Both are cheap; neither stores position in the user's data.

## Deferred / open

- Composite and nested-path identity (declared, mechanical).
- Repeatable ordered sequences → synthetic per-element ids.
- In-place ordered arrays (the third kind) — concept captured here, build later.
- **Name of the new kind**: `effect` / `consequence` / `shift` — provisional;
  pick one.
- Whether `move` is its own kind or a flavour of `modify`, and how to represent
  several elements crossing at once (per-element from/to vs a minimal move-set).
