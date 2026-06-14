# patchwork

A JSON editing engine with base/draft, diff, undo, and scoped lenses.

```bash
npm install @maxjay/patchwork
```

## The core model

patchwork wraps any JSON document in an `Engine`. On construction, two deep clones are taken: one as `base`, one as `draft`. They start identical and diverge as you mutate.

```ts
import { Engine } from '@maxjay/patchwork'

const engine = new Engine({
  server: { host: 'localhost', port: 8080 },
  debug: false,
})

engine.base   // { server: { host: 'localhost', port: 8080 }, debug: false }
engine.draft  // identical until you mutate
```

**`base`** is the committed truth. It moves only when you call `accept()`. **`draft`** is the working copy. All mutations target draft. That is the whole model.

### Schema

The `Engine` constructor accepts an optional `schema` that describes the shape of your document. Right now it has one job: telling the engine which arrays have identity and whether order matters in them.

```ts
const engine = new Engine(
  {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob'   },
    ],
    steps: [
      { id: 'a', label: 'Fetch' },
      { id: 'b', label: 'Process' },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          'x-key': 'id',           // match elements by id field
          items: { type: 'object' },
        },
        steps: {
          type: 'array',
          'x-key': 'id',           // match elements by id field
          'x-ordered': true,        // position matters — surface displacement
          items: { type: 'object' },
        },
      },
    },
  },
)
```

`x-key` is the field that uniquely identifies each element across `base` and `draft`. Without it, arrays are diffed by position. `x-ordered` tells patchwork that position is meaningful in that array, so shifts get surfaced in the diff. Both are covered fully in [Arrays](/arrays).

## Mutations

All mutations take a [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) expression and target `draft`. `base` is never touched until you call `accept()`.

### add

On an object, `add` sets the key. On an array, it splices: the element at that index and everything after it shifts right.

```ts
const engine = new Engine({ user: { name: 'Alice' }, tags: ['a', 'b', 'c'] } as any)

engine.add('$.user.role', 'admin')   // new key on object
engine.add('$.tags[1]', 'x')        // splice into array at index 1

engine.draft
// { user: { name: 'Alice', role: 'admin' }, tags: ['a', 'x', 'b', 'c'] }
```

Append to an array with the `[-]` sentinel:

```ts
engine.add('$.tags[-]', 'd')
// tags is now ['a', 'x', 'b', 'c', 'd']
```

`add` creates intermediate nodes. If any segment of the path does not exist, it is created:

```ts
const engine = new Engine({})
engine.add('$.config.server.port', 8080)
engine.draft  // { config: { server: { port: 8080 } } }
```

For how `diff()` represents adds, including the difference between keyed and unkeyed arrays, see [Arrays](/arrays).

### replace

Replaces the value at a path. The previous value is captured as `oldValue` in the diff.

```ts
const engine = new Engine({ server: { host: 'localhost', port: 8080 } })

engine.replace('$.server.port', 443)

engine.draft
// { server: { host: 'localhost', port: 443 } }

engine.diff()
// [ { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 } ]
```

Wildcards replace every match in one call:

```ts
const engine = new Engine({
  servers: [{ host: 'a.internal' }, { host: 'b.internal' }],
})

engine.replace('$.servers[*].host', 'prod.example.com')

engine.draft.servers
// [{ host: 'prod.example.com' }, { host: 'prod.example.com' }]

engine.diff()
// [
//   { op: 'replace', path: "$['servers'][0]['host']", oldValue: 'a.internal', value: 'prod.example.com' },
//   { op: 'replace', path: "$['servers'][1]['host']", oldValue: 'b.internal', value: 'prod.example.com' },
// ]
```

### delete

On an object, `delete` removes the key. On an array, it splices: the gap closes and everything after shifts left.

```ts
const engine = new Engine({ user: { name: 'Alice', role: 'user' }, debug: true } as any)

engine.delete('$.user.role')
engine.delete('$.debug')

engine.draft
// { user: { name: 'Alice' } }

engine.diff()
// [
//   { op: 'remove', path: "$['user']['role']", value: 'user' },
//   { op: 'remove', path: "$['debug']",        value: true   },
// ]
```

Filter selectors let you delete by condition across the whole document:

```ts
engine.delete('$..*[?@.deprecated == true]')
```

For how `diff()` represents deletes on arrays, keyed vs unkeyed, see [Arrays](/arrays).

### move

Removes the value at `from` and sets it at `to`. Source must resolve to exactly one node.

```ts
const engine = new Engine({
  user: { firstName: 'Alice', role: 'user' },
  admin: null,
} as any)

engine.move('$.user.role', '$.admin')

engine.draft
// { user: { firstName: 'Alice' }, admin: 'user' }

engine.diff()
// [
//   { op: 'remove',  path: "$['user']['role']", value: 'user' },
//   { op: 'replace', path: "$['admin']", oldValue: null, value: 'user' },
// ]
```

`diff()` shows the net structural change: the source was removed, the target was set. The `move` op itself lives on the undo stack, visible via `exportChanges()`.

### copy

Same as `move` but leaves the source intact.

```ts
const engine = new Engine({ template: { color: '#fff', size: 12 }, active: {} } as any)

engine.copy('$.template', '$.active')

engine.draft
// { template: { color: '#fff', size: 12 }, active: { color: '#fff', size: 12 } }

engine.diff()
// [
//   { op: 'add', path: "$['active']['color']", value: '#fff' },
//   { op: 'add', path: "$['active']['size']",  value: 12     },
// ]
```

Same as `move`: `diff()` shows the structural result, not the copy operation itself.

### revert

Resets draft at a path back to whatever base has there. Not the same as `undo`: `revert` is a snapshot reset that compares base to draft at that path. It pushes its own reversible entry onto the undo stack.

```ts
const engine = new Engine({ a: 1, b: 2 })

engine.replace('$.a', 99)
engine.replace('$.b', 99)

engine.revert('$.a')

engine.draft   // { a: 1, b: 99 }
engine.diff()  // [ { op: 'replace', path: "$['b']", oldValue: 2, value: 99 } ]
```

Pass a query to revert multiple paths at once:

```ts
engine.revert('$.servers[*].host')
```

If the path existed in base but was deleted in draft, `revert` re-inserts it. If it was added in draft and base has nothing there, `revert` removes it.

## Diff

`diff()` returns the net structural difference between `base` and `draft` as a flat list of `DiffOp` objects. It is a snapshot comparison, independent of the undo stack. If you replace a value twice and undo both, `diff()` returns `[]`. The stack saw two operations. The snapshot sees no change.

```ts
engine.diff()
// [
//   { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 },
//   { op: 'add',     path: "$['server']['ssl']",  value: true },
//   { op: 'remove',  path: "$['debug']",          value: false },
// ]
```

Scope the diff to any path. Deleted nodes are resolved via base, so nothing is missed:

```ts
engine.diff('$.server')    // only ops touching the server subtree
engine.diff('$.items[*]')  // only ops touching array elements
```

## Undo / redo

Every mutation pushes a reversible operation onto a linear stack.

```ts
engine.replace('$.count', 1)
engine.replace('$.count', 2)
engine.replace('$.count', 3)

engine.undo()  // count is 2
engine.undo()  // count is 1
engine.redo()  // count is 2
```

`accept()` and `decline()` are on the stack too. Committing is reversible. Any new mutation clears the redo stack.

## Accept / decline

```ts
engine.accept()   // base gets a fresh clone of draft
engine.decline()  // draft gets a fresh clone of base
```

## Ephemeral sessions

Collapse a burst of mutations into a single undo entry. Useful for streaming output, keystroke-level form binding, or hover previews.

```ts
engine.beginEphemeral()

for await (const chunk of stream) {
  engine.replace('$.response', chunk)
}

engine.commitEphemeral()
// one undo() snaps all the way back to the pre-stream state
```

`discardEphemeral()` cancels instead. All session mutations are unwound with no history entry.

## Scoped lenses

`getNodeEngine(path)` returns a lens scoped to a subtree. It holds no state of its own. Reads resolve through the parent on every access and writes forward to the parent with paths rewritten. Both sides see the same physical state.

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

- `cars.diff()` returns ops touching cars only. Paths are relative to `$`; each op also carries `absolutePath` with the full document path.
- `cars.accept()` commits the cars subtree into parent's base. Trucks are unaffected.
- `cars.undo()` / `cars.redo()` delegate to the parent. There is one shared stack.

Lenses compose. Calling `getNodeEngine` on a `NodeEngine` joins the paths and creates a further-scoped lens against the same root.

## Export and replay

```ts
const ops = engine.exportChanges()

const other = new Engine(originalDoc)
other.importChanges(ops)
// other.draft matches engine.draft
```
