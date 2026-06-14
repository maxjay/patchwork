# Array diffing

## The default: index-zip

Without a declared identity, patchwork diffs arrays position-by-position. This is correct for fixed-position arrays (tuples, coordinate pairs, config slots) but wrong for most everything else.

```ts
const engine = new Engine({ items: ['A', 'B', 'C'] })
engine.delete('$.items[0]')

engine.diff()
// [
//   { op: 'replace', path: "$['items'][0]", oldValue: 'A', value: 'B' },
//   { op: 'replace', path: "$['items'][1]", oldValue: 'B', value: 'C' },
//   { op: 'remove',  path: "$['items'][2]", value: 'C' },
// ]
```

One delete produced three ops — a cascade of false replaces. Everything after the deleted element looks like it changed.

---

## x-key: identity matching

Declare `x-key` on an array schema and patchwork matches elements across `base` and `draft` by that field. One delete produces one `remove` op, regardless of what follows it.

```ts
const engine = new Engine(
  {
    regions: [
      { id: 'us-east', capacity: 100 },
      { id: 'eu-west', capacity: 80  },
      { id: 'ap-south', capacity: 60 },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          'x-key': 'id',
          items: { type: 'object' },
        },
      },
    },
  },
)

engine.delete('$.regions[0]')

engine.diff()
// [
//   { op: 'remove', path: "$['regions'][0]", value: { id: 'us-east', ... }, identity: 'us-east' }
// ]
// one op — not a cascade
```

`identity` on the `DiffOp` carries the matched key value directly. Consumers don't need schema knowledge to identify what was added or removed.

For a one-off without a schema:

```ts
engine.diff('$.regions', { key: 'id' })
```

### Field changes: element-level replace

When a matched element's fields change, patchwork emits a `replace` op at the **element level** — not at each field individually. The field-level diffs are grouped inside `changes`.

```ts
engine.replace('$.regions[0].capacity', 90)

engine.diff()
// [
//   {
//     op: 'replace',
//     path: "$['regions'][0]",
//     identity: 'eu-west',
//     displacement: 0,
//     value:    { id: 'eu-west', capacity: 90 },
//     oldValue: { id: 'eu-west', capacity: 80 },
//     changes: [
//       { op: 'replace', path: "$['regions'][0]['capacity']", oldValue: 80, value: 90 }
//     ]
//   }
// ]
```

**`changes`** paths are absolute document paths — you can pass them directly to `restore()` for sub-field reversion.

### Nesting and cascade

`x-key` nests: arrays inside arrays can each declare their own key. By default, a change inside a nested keyed array **bubbles up** — the parent element is marked `modified`, and the nested change appears in its `changes` array.

```ts
// parent array x-key: 'gid', items contain a members array x-key: 'uid'
engine.delete('$.groups[0].members[0]')

engine.diff()
// [
//   {
//     op: 'replace', path: "$['groups'][0]", identity: 'g1',
//     changes: [{ op: 'remove', path: "$['groups'][0]['members'][0]", identity: 'u1', ... }]
//   }
// ]
```

Pass `cascade: false` to contain changes within their own identity boundary — a nested change will not mark the parent as modified:

```ts
engine.diff(undefined, { cascade: false })
// [] — parent is unchanged from its own perspective
```

---

## x-ordered: ordered sequences

Add `x-ordered: true` to declare that position is meaningful. When an element's index shifts because something was added or removed nearby, patchwork surfaces that as a **`move` op** — a displacement.

```ts
const engine = new Engine(
  {
    steps: [
      { id: 'a', label: 'Fetch' },
      { id: 'b', label: 'Validate' },
      { id: 'c', label: 'Transform' },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          'x-key': 'id',
          'x-ordered': true,
          items: { type: 'object' },
        },
      },
    },
  },
)

engine.delete('$.steps[1]')  // remove 'Validate'

engine.diff()
// [
//   { op: 'remove', from: "$['steps'][1]", identity: 'b' },
//   { op: 'move',   from: "$['steps'][2]", to: "$['steps'][1]", identity: 'c' }
// ]
```

`c` (Transform) moved from index 2 to index 1. The `move` op carries:
- **`from`** — where the element was in base
- **`to`** — where it is in draft
- **`identity`** — which element was displaced

### Displacement on modified elements

If an element is both field-changed and displaced, the `replace` op carries both: `changes` for the field diffs and `displacement` (integer delta: `draftIndex - baseIndex`) for the position shift.

```ts
// add X before 'Fetch', then change 'Fetch' label
engine.add('$.steps[0]', { id: 'x', label: 'Setup' })
engine.replace('$.steps[1].label', 'Fetch data')

engine.diff()
// [
//   { op: 'add', ..., identity: 'x' },
//   {
//     op: 'replace', path: "$['steps'][1]", identity: 'a',
//     displacement: 1,   // shifted right by 1
//     changes: [{ op: 'replace', path: "$['steps'][1]['label']", ... }]
//   }
// ]
```

### Restoring displacement

Pass the `move` op to `restore()`. It splices the element back to its base position:

```ts
const moveOp = engine.diff().find(o => o.op === 'move' && o.identity === 'c')
engine.restore(moveOp)  // c is spliced back to index 2
```

### Cancellation

An add and a remove at the same position cancel out — the net displacement for surrounding elements is zero, and no `move` op is emitted:

```ts
engine.delete('$.steps[1]')     // remove 'Validate' at index 1
engine.add('$.steps[1]', { id: 'x', label: 'New step' })  // insert at index 1

engine.diff('$.steps')
// [ remove for 'Validate', add for 'x' ]
// no move ops for 'Transform' — its net displacement is 0
```

---

## x-key: '$self' — set semantics

For arrays of primitives that are semantically sets — tags, permissions, feature flags — declare `x-key: '$self'`. The item itself is the identity.

Reorders are invisible (sets have no order). Duplicates collapse (sets have no duplicates). A single add or remove produces a single op.

```ts
const engine = new Engine(
  { permissions: ['read', 'write', 'admin'] },
  {
    schema: {
      type: 'object',
      properties: {
        permissions: { type: 'array', 'x-key': '$self', items: { type: 'string' } },
      },
    },
  },
)

engine.delete('$.permissions[1]')

engine.diff()
// [ { op: 'remove', path: "$['permissions'][1]", value: 'write', identity: 'write' } ]
```

Restricted to primitive items. For sets of objects, add a stable ID field and use `x-key: '<field>'`.

---

## Full list rendering: includeUnchanged

By default, `diff()` returns only changed elements. Pass `includeUnchanged: true` to get every element — changed or not — each tagged with an `op` of `unchanged`. This lets you render a complete list with change highlighting from one call, without merging the diff against the raw array yourself.

```ts
engine.diff('$.regions', { key: 'id', includeUnchanged: true })
// add / replace / remove / move for changed elements
// { op: 'unchanged', path, identity, value, displacement: 0 } for stable ones
```

---

## Identity stability

If the field that `x-key` points to changes value, the diff sees it as a **remove + add** — not a modify. This is by design. Identity is the slice of an element that doesn't change when you edit everything else. Changing it means a different element.

```ts
engine.replace('$.regions[0].id', 'us-west')

engine.diff()
// [
//   { op: 'remove', ..., identity: 'us-east' },
//   { op: 'add',    ..., identity: 'us-west'  },
// ]
// not a replace — the old element is gone, a new one appeared
```
