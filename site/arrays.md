# Arrays

Before patchwork can tell you what changed in an array, it needs to answer a harder question: **what does it mean for an array element to change?**

The answer depends entirely on what your array is.

## The problem with position

The simplest diff strategy is to compare elements by position. Element 0 in base against element 0 in draft, element 1 against element 1, and so on.

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

One element was deleted. The diff says three things changed. It is not wrong: positions 0 and 1 did get new values. But B and C did not change. They moved. The diff is reporting the consequence of the removal rather than the removal itself.

For a tuple or a fixed-position config array this is correct. Position is the identity. Slot 0 means something specific and independent of what is in it.

For almost everything else, a list of users, a set of tags, a pipeline of steps, this is the wrong model.

## What makes an element the same element?

To diff an array correctly you need to know: when an element moves, is it still the same element? When you look at two snapshots of an array, which elements in draft correspond to which elements in base?

For objects with a stable ID field the answer is clear. `{ id: 2, name: 'Bob' }` in draft is the same element as `{ id: 2, name: 'Bob' }` in base, regardless of where in the array it sits. You declare this with `x-key`:

```ts
const engine = new Engine(
  {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob'   },
      { id: 3, name: 'Carol' },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          'x-key': 'id',
          items: { type: 'object' },
        },
      },
    },
  },
)

engine.delete('$.users[1]')

engine.diff()
// [
//   { op: 'remove', path: "$['users'][1]", value: { id: 2, name: 'Bob' }, identity: 2 }
// ]
// one op. Alice and Carol are untouched.
```

With `x-key: 'id'`, patchwork matches elements across snapshots by identity, not position. One deletion produces one `remove` op.

Field changes on a matched element produce a single `replace` op at the element level. The individual field diffs are nested inside `changes`:

```ts
engine.replace('$.users[0].name', 'Alice (admin)')

engine.diff()
// [
//   {
//     op: 'replace',
//     path: "$['users'][0]",
//     identity: 1,
//     value:    { id: 1, name: 'Alice (admin)' },
//     oldValue: { id: 1, name: 'Alice'         },
//     displacement: 0,
//     changes: [
//       { op: 'replace', path: "$['users'][0]['name']", oldValue: 'Alice', value: 'Alice (admin)' }
//     ]
//   }
// ]
```

The element is the unit. Its internal changes are grouped under it.

### Identity is declared, not inferred

`x-key` must be declared explicitly. patchwork does not attempt to guess which field is the identity.

The reason: identity must be the part of an element that does not change when you edit everything else. If patchwork guessed wrong and you later edited that field, it would misidentify the element. Structural or whole-value identity breaks the instant you edit. An edit would look like a remove and an add.

If the `x-key` field itself changes, patchwork treats it as a remove of the original element and an add of a new one. That is the correct interpretation. A different identity is a different element.

## Does position matter?

So far we have talked about membership: which elements exist. There is a second question: does the order of elements matter?

For some arrays it does not. A list of user permissions, a set of tags, a collection of config objects keyed by ID. These are bags. You care about what is in them, not the order they are in. Removing element B and shifting C from index 2 to index 1 is irrelevant. C did not change.

For other arrays, order is the whole point. A pipeline of steps, a playlist, a ranked list. Position is meaningful. If C shifts from index 2 to index 1, something real happened: C is now in a different slot in the sequence.

patchwork needs to know which you mean. You declare it with `x-ordered`:

```ts
// unordered (default): position shifts are invisible
{ type: 'array', 'x-key': 'id' }

// ordered: position shifts are surfaced
{ type: 'array', 'x-key': 'id', 'x-ordered': true }
```

## Displacement in ordered arrays

When an array is ordered and an element's position changes because something was added or removed near it, that shift is real and patchwork surfaces it. We call this displacement.

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
        steps: { type: 'array', 'x-key': 'id', 'x-ordered': true, items: { type: 'object' } },
      },
    },
  },
)

engine.delete('$.steps[1]')

engine.diff()
// [
//   { op: 'remove', ..., identity: 'b' },
//   { op: 'move', from: "$['steps'][2]", to: "$['steps'][1]", identity: 'c' }
// ]
```

'Transform' moved from index 2 to index 1. The `move` op carries `from` (where it was in base), `to` (where it is in draft), and `identity` (which element). An element that was also field-changed in the same snapshot gets a `replace` op with a non-zero `displacement` field alongside its `changes`.

### Displacement is revertible

Pass the `move` op to `restore()` to splice the element back to its original position:

```ts
const ops = engine.diff()
const displaced = ops.find(o => o.op === 'move' && o.identity === 'c')
engine.restore(displaced)  // 'Transform' spliced back to index 2
engine.undo()              // un-does the restore
```

### Cancellation

An add and a remove at the same position cancel each other out. The net displacement for surrounding elements is zero, so no `move` ops are emitted:

```ts
engine.delete('$.steps[1]')
engine.add('$.steps[1]', { id: 'x', label: 'New' })

engine.diff('$.steps')
// [ remove for 'b', add for 'x' ]
// no move op for 'c'. Its net position did not change.
```

## Primitive sets: x-key '$self'

For arrays of primitives that are semantically sets, tags, permission names, feature flags, there is no field to use as an identity. The value itself is the identity. Declare `x-key: '$self'`:

```ts
const engine = new Engine(
  { tags: ['urgent', 'bug', 'backend'] },
  {
    schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', 'x-key': '$self', items: { type: 'string' } },
      },
    },
  },
)

engine.delete('$.tags[1]')

engine.diff()
// [ { op: 'remove', path: "$['tags'][1]", value: 'bug', identity: 'bug' } ]
```

Under `$self`, reorders are invisible (sets have no order), duplicates collapse (sets have no duplicates), and a single add or remove produces a single op regardless of where in the array it falls. Restricted to primitive items. For sets of objects, add a stable ID field and use `x-key: '<field>'`.

## Rendering full lists

By default, `diff()` returns only changed elements. For a UI that needs to render the complete list, pass `includeUnchanged: true`:

```ts
engine.diff('$.users', { includeUnchanged: true })
// every element returned, each tagged with its state:
// add / replace / move for changed elements
// { op: 'unchanged', identity, value, displacement: 0 } for stable ones
```

One dataset drives both the full list rendering and the change summary. No merging required.

## Nested arrays

`x-key` nests. Arrays inside elements can each declare their own key. By default, a change inside a nested keyed array bubbles up and marks the parent element as modified. The nested change appears inside the parent element's `changes` array.

To contain changes within their own identity boundary, pass `cascade: false`:

```ts
engine.diff(undefined, { cascade: false })
```

Use this when you are diffing at the parent level and want to know only about direct field changes, not what happened inside nested child collections.
