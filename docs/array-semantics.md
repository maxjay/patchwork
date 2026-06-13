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
properly rather than papering it over.

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

4. **Order, when it matters, is a hidden position attribute the engine
   reconciles.** Not stored in the data — a synthetic attribute that travels
   with the element at diff time. Disturbing it is a real modification, exactly
   like editing a real field. (This is the correction to "just compare the two
   indices": position is *carried*, not merely compared.)

## The three kinds

### 1. Unordered array — a bag
Position is noise; order means nothing.

- **Diff = membership only.**
  - in `base`, not `draft` → `remove` (one op, identified by key)
  - in `draft`, not `base` → `add`
  - in both, fields differ → `modify` (on the element)
  - reorder → invisible
  - Removing **B** does **not** touch **C**. C's index shifts physically, but
    nothing *about* C changed — same identity, same fields, and there is no
    position attribute to disturb.
- **Revert = restore membership.** Position is irrelevant; re-insert anywhere
  (append). Nothing to compute, nothing to guess. (This is what killed the
  "ghost position" heuristic — it only existed because order mattered somewhere
  with no model for it.)
- Typical: tags, permissions, a collection of config objects keyed by id.

### 2. Ordered array — a sequence
Position is data. Each element carries a hidden position attribute.

- **Diff = membership + position.**
  - `add` / `remove` / `modify` as above, **plus**
  - removing **B** shifts everyone after it → their position attribute changed →
    real position `modify` ops. The cascade is *correct* here: their positions
    genuinely changed.
  - a pure reorder (same members, new order) → a set of position-attribute
    changes.
- **Revert = restore membership + position.** Because position is a carried
  attribute, revert restores it exactly — re-insert B at its recorded position,
  the rest fall back. No neighbour-guessing.
- Identity note: an ordered sequence of *unique* values may use `$self`; a
  sequence that may *repeat* values cannot (the value collides) and needs a real
  or synthetic per-element id.

### 3. In-place ordered array — fixed slots
Ordered, but removal **keeps the slot** instead of closing the gap.

- **Diff = membership + position, slots fixed.** Removing **B** vacates B's slot
  but does **not** shift C, D… — their positions are unchanged. So a removal is
  isolated in position terms (no cascade), unlike the gap-closing ordered case.
- **Revert = restore B into its (still-reserved) slot.** Exact, no cascade.
- Open (deferred): what occupies a vacated slot (hole / null / tombstone),
  whether array length is preserved, how "add into a hole" differs from "add new".

## Summary

| kind | remove B affects others? | reorder visible? | revert position |
|---|---|---|---|
| unordered | no | no | irrelevant (append) |
| ordered (gap-closing) | yes — they shift | yes | restored exactly |
| ordered in-place | no — slot stays empty | n/a (fixed slots) | restored to its slot |

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

## Implementation stance (direction, not detailed design)

- **Drop the filter-string identity paths and the segment canonicalize/resolve
  round-trip.** Identity stays a declared concept; the `identity` field carries
  it in output. We do not serialize identity into path strings.
- **Express revert with the same functional machinery as undo/redo.** Every
  operation already captures `{ undo, redo }` closures over concrete state;
  revert should do the same — capture *what to restore* (the element, and its
  position when ordered) as a closure — rather than re-deriving locations from
  path strings at apply time.
- **Position (ordered) is a synthetic attribute reconciled at diff time**,
  compared like a field; never stored in the user's data.

## Deferred / open

- Composite and nested-path identity (declared, mechanical).
- Repeatable ordered sequences → synthetic per-element ids.
- In-place ordered arrays (the third kind) — concept captured here, build later.
- Diff representation of ordered position changes: per-element position deltas
  (the cascade) vs a minimal move-set. The cascade is acceptable; move-
  minimisation is a possible later refinement.
