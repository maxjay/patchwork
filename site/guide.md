# Guide

## The core model

patchwork wraps any JSON document in an `Engine`. On construction, two independent deep clones are taken — one as `base`, one as `draft`. They start identical and diverge as you mutate.

```ts
import { Engine } from '@maxjay/patchwork'

const engine = new Engine({
  server: { host: 'localhost', port: 8080 },
  debug: false,
})

engine.base   // { server: { host: 'localhost', port: 8080 }, debug: false }
engine.draft  // same — identical until you mutate
```

**`base`** is the committed truth. It moves only when you call `accept()`. **`draft`** is the working copy. All mutations target draft.

That's the whole model. Everything else — diff, undo, lenses — is built on top of it.

---

## Mutations

All mutations take a [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) expression. The same expression you'd use to read a value works identically as a write target.

```ts
engine.replace('$.server.port', 443)
engine.add('$.server.ssl', true)
engine.delete('$.debug')

engine.draft  // { server: { host: 'localhost', port: 443, ssl: true } }
engine.base   // { server: { host: 'localhost', port: 8080 }, debug: false }
```

| Method | Behaviour |
|---|---|
| `.add(path, value)` | Splices into arrays at the given index; sets on objects. Creates intermediate nodes on literal paths. |
| `.replace(path, value)` | Replaces the matched value. Wildcards replace all matches. |
| `.delete(path)` | Removes at path. Splices arrays in place. |
| `.move(from, to)` | Moves a value. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copies a value. Source must resolve to exactly one node. |
| `.revert(path)` | Resets draft at path back to whatever base has there. Accepts queries — `$.items[*]` reverts every item. |
| `.restore(op)` | Inverts a specific `DiffOp` from `diff()` and pushes it onto the undo stack. See [restoring from diff](#restoring-from-diff). |

Wildcards and filter selectors work anywhere a path is accepted:

```ts
engine.replace('$.servers[*].host', 'prod')   // all hosts at once
engine.delete('$..*[?@.deprecated]')           // any deprecated node, anywhere
```

---

## Diff

`diff()` returns the net structural difference between `base` and `draft` as a flat list of `DiffOp` objects. It is a **snapshot comparison** — independent of the undo stack and independent of how many mutations produced the current state.

```ts
engine.diff()
// [
//   { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 },
//   { op: 'add',     path: "$['server']['ssl']",  value: true },
//   { op: 'remove',  path: "$['debug']",          value: false },
// ]
```

Scope the diff to any JSONPath. The path resolves against both `base` and `draft`, so nodes that were deleted in draft are still found via base:

```ts
engine.diff('$.server')    // only ops touching the server subtree
engine.diff('$.items[*]')  // only ops touching array elements
```

If you replace a value twice and undo both, `diff()` returns `[]`. The undo stack saw two operations; the snapshot sees no change. The stack and the diff are independent.

---

## Undo / redo

Every mutation pushes a reversible `Operation` onto a linear undo stack. `undo()` pops the last entry and executes its inverse. `redo()` replays it.

```ts
engine.replace('$.count', 1)
engine.replace('$.count', 2)
engine.replace('$.count', 3)

engine.undo()  // count → 2
engine.undo()  // count → 1
engine.redo()  // count → 2
```

Any new mutation clears the redo stack — you cannot branch history.

**`accept()` and `decline()` are on the undo stack.** Committing is reversible:

```ts
engine.replace('$.role', 'admin')
engine.accept()   // base ← clone(draft)
engine.undo()     // base restored — the accept is reversed
```

---

## Accept / decline

`accept()` promotes draft into base. `decline()` resets draft from base. Both are reversible.

```ts
engine.replace('$.role', 'admin')
engine.accept()
// base: { role: 'admin' }
// draft: { role: 'admin' }

engine.replace('$.name', 'Bob')
engine.decline()
// draft reset to base — name change discarded
// base unchanged
```

---

## Ephemeral sessions

Some write patterns don't belong on the undo stack individually — streaming LLM output updating a field on every chunk, keystroke-level form binding, hover previews. `beginEphemeral()` marks the start of a session; `commitEphemeral()` collapses everything since the mark into a single undo entry.

```ts
engine.beginEphemeral()

for await (const chunk of stream) {
  engine.replace('$.response', chunk)  // draft updates live
}

engine.commitEphemeral()
// one undo() snaps back to the pre-stream state
```

`discardEphemeral()` cancels instead — unwinds all session mutations, no history entry.

---

## Scoped lenses

`getNodeEngine(path)` returns a `NodeEngine` — a zero-state lens onto a subtree. It holds no data of its own. Reads resolve through the parent on every access; writes forward to the parent with paths rewritten into the parent's frame. Both sides see the same physical state.

```ts
const engine = new Engine({
  cars:   [{ color: 'red' }],
  trucks: [{ color: 'blue' }],
})

const cars = engine.getNodeEngine('$.cars')

cars.replace('$[0].color', 'yellow')

engine.draft.cars[0].color  // 'yellow'
cars.draft[0].color          // 'yellow'
```

Scoped behaviour on the lens:

- **`cars.diff()`** — ops touching cars only. Paths are relative to `$`; each op also carries `absolutePath` with the full document path.
- **`cars.accept()`** — commits the cars subtree into parent's base. Trucks are unaffected.
- **`cars.undo()` / `cars.redo()`** — delegate to the parent. There is one shared undo stack.

Lenses compose — `getNodeEngine` on a `NodeEngine` joins paths and creates a further-scoped lens against the same root.

---

## Export and replay

The undo stack stores structural mutations. `exportChanges()` returns them as a `DiffOp[]`. `importChanges()` applies them to another engine.

```ts
const ops = engine.exportChanges()

const other = new Engine(originalDoc)
other.importChanges(ops)
// other.draft is now identical to engine.draft
```

This is useful for server-side replay, syncing state between instances, and persisting edit sessions.

---

## Restoring from diff

`restore(op)` inverts a single `DiffOp` from `diff()` and pushes the inverse onto the undo stack. The diff must reflect the current draft state — if you mutate after diffing, re-diff before restoring.

```ts
const ops = engine.diff('$.users')

const removed = ops.find(o => o.op === 'remove' && o.identity === 2)
engine.restore(removed)  // re-inserts the removed element
engine.undo()            // un-does the restore
```

| op | what restore does |
|---|---|
| `add` | deletes the element |
| `remove` | re-inserts it at its original position |
| `replace` | reverts to `oldValue` |
| `move` | splices back to the base position |

For array identity and displacement, see the [Array diffing guide](/arrays).
