<p align="center">
  <h1 align="center">patchwork</h1>
  <p align="center">A JSON editing engine with base/draft, diff, undo, ephemeral sessions, and scoped lenses.</p>
</p>

<p align="center">
  <a href="#motivation">Motivation</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#jsonpath-querying">JSONPath querying</a> &middot;
  <a href="#array-diffing">Array diffing</a> &middot;
  <a href="#scoped-lenses">Scoped lenses</a> &middot;
  <a href="#llm-integration">LLM integration</a> &middot;
  <a href="#angular-integration">Angular</a> &middot;
  <a href="#api">API</a>
</p>

---

## Motivation

Building a config editor, settings panel, or any UI over structured data means wiring up the same three concerns every time:

- **What changed?** A diff between the saved state and the current edit.
- **Undo/redo** that survives saves, across every operation.
- **Review before commit** — inspect pending changes before they land.

Patchwork wraps any JSON document in an `Engine` that holds two views — `base` (committed) and `draft` (working) — and a stack of reversible operations. That single primitive covers all three.

Addressing uses [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) throughout. The same expression you write to read a value works identically to target a write or scope a diff. Diff output follows the [JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902) operation vocabulary (`add`, `replace`, `remove`, `move`, `copy`) so it maps onto existing patch tooling and transports.

## Install

```bash
npm install @maxjay/patchwork
```

## How it works

### 1. Wrap any JSON document

```ts
import { Engine } from '@maxjay/patchwork';

const engine = new Engine({
  server: { host: 'localhost', port: 8080 },
  debug: false,
});
```

Two independent deep clones are taken on construction — one as `base`, one as `draft`. They start identical and diverge as you mutate.

### 2. Mutate the draft

All mutations target `draft`. `base` doesn't move until you `accept()`.

```ts
engine.replace('$.server.port', 443);
engine.add('$.server.ssl', true);
engine.delete('$.debug');

engine.draft;  // { server: { host: 'localhost', port: 443, ssl: true } }
engine.base;   // { server: { host: 'localhost', port: 8080 }, debug: false }
```

| Method | Description |
|---|---|
| `.add(path, value)` | Splice into arrays or set on objects. Creates intermediate nodes on literal paths. |
| `.replace(path, value)` | Replace matched values. Wildcards replace all matches. |
| `.delete(path)` | Remove at path. Splices arrays in place. |
| `.move(from, to)` | Move a value. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copy a value. Source must resolve to exactly one node. |
| `.revert(path)` | Reset draft at path back to whatever `base` has there. Identity-aware inside keyed arrays: a removed element is re-inserted, an added one removed, a modified one restored in place. |

### 3. See what changed

`diff()` returns the net structural difference between `base` and `draft` as a flat list of `DiffOp` objects. It's a snapshot comparison — independent of the undo stack.

```ts
engine.diff();
// [
//   { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 },
//   { op: 'add',     path: "$['server']['ssl']",  value: true },
//   { op: 'remove',  path: "$['debug']",          value: false },
// ]
```

Scope the diff with a JSONPath — resolves against both `base` and `draft` so deleted nodes are never missed:

```ts
engine.diff('$.server');   // only ops touching the server subtree
engine.diff('$.items[*]'); // only ops touching array elements
```

### 4. Undo anything

Every mutation pushes onto a single linear undo stack.

```ts
engine.undo();  // reverse last op
engine.redo();  // replay it
```

`accept()` and `decline()` are themselves on the stack — committing doesn't erase history.

### 5. Commit or discard

```ts
engine.accept();   // base ← clone(draft). draft untouched.
engine.decline();  // draft ← clone(base). pending edits discarded.
```

### 6. Ephemeral sessions

Some write patterns don't belong on the undo stack — streaming output updating a field on every chunk, hover previews, keystroke-level form binding. `beginEphemeral` opens a session where mutations proceed normally; `commitEphemeral` collapses the whole session into one undo entry.

```ts
engine.beginEphemeral();

for await (const chunk of stream) {
  engine.replace('$.response', chunk);  // draft updates live
}

engine.commitEphemeral();
// one undo() snaps back to the pre-stream state
```

`discardEphemeral()` cancels instead — unwinds all session mutations, no history trace.

### 7. Export and replay

```ts
const ops = engine.exportChanges();   // DiffOp[] from the undo stack

const other = new Engine(originalDoc);
other.importChanges(ops);
// other.draft is now identical to engine.draft
```

## JSONPath querying

Every operation in patchwork — reads, writes, diffs — accepts the same [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) expression. There is no separate addressing system for mutations vs queries.

```ts
// Reads
engine.get('$.servers[*].host');           // all hosts
engine.get('$..*[?@.enabled == true]');    // any enabled node, anywhere
engine.getValue('$.config.timeout');       // strict single-match

// Writes — same paths
engine.replace('$.servers[*].host', 'prod'); // replace all hosts
engine.delete('$..*[?@.deprecated]');        // remove any deprecated node

// Diff — same paths
engine.diff('$.servers[*]');                 // ops touching any server
```

Paths returned by `get()` come back in normalized form (`$['key'][0]`) and can be fed straight back into `replace`, `delete`, etc.

Selector reference:

| Syntax | Matches |
|---|---|
| `$.key` / `$['key']` | Named property |
| `$[0]` | Array index |
| `$[*]` / `$['*']` | All children |
| `$..*` | All descendants (recursive descent) |
| `$[?@.x == 1]` | Filter — elements where condition holds |
| `$[2:5]` | Slice |

## Array diffing

### Default: index-zip

Without a declared identity, arrays are diffed position-by-position. Deleting the first element shifts every following element, producing a cascade of false `replace` ops — one per element that moved. This is correct for fixed-position arrays (tuples, coordinate pairs) but wrong for most everything else.

### Identity-keyed: `x-key`

Declare `x-key` on an array schema and patchwork matches elements across `base` and `draft` by that field. One element deleted produces one `remove` op, regardless of what follows it.

```ts
const engine = new Engine(
  {
    regions: [
      { id: 'us-east', capacity: 100 },
      { id: 'eu-west', capacity: 80 },
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
);

engine.delete('$.regions[0]');

engine.diff();
// [ { op: 'remove', path: `$['regions'][?@['id'] == "us-east"]`, value: { id: 'us-east', ... }, identity: 'us-east' } ]
// one op — not a cascade
```

Inside a keyed array, ops carry **identity paths**: the element segment is an RFC 9535 filter on the key instead of an index. Indexes can't address keyed elements coherently — a removed element only has a position in `base`, an added one only in `draft` — but an identity path means the same element against either document, never goes stale when the array is spliced, and feeds straight back into `replace` / `delete` / `get` like any other path.

`x-key` nests: arrays inside arrays can each declare their own key, and the filters compose — `$['users'][?@['email'] == "a@x.com"]['tags'][?@ == "x"]`.

The `identity` field on `DiffOp` carries the matched key value directly, so consumers don't need to parse it out of the path.

`x-key` declares a contract: every item carries a primitive value under the key, unique within the array. `diff()` throws if the data breaks it (duplicate or missing identities) rather than producing a quietly wrong diff.

For a one-off without a schema:

```ts
engine.diff('$.regions', { key: 'id' });
```

### Set semantics: `x-key: '$self'`

For arrays of primitives that are semantically sets — tags, permission names, status flags — declare `x-key: '$self'`. The item itself is the identity. Reorders are invisible (sets have no order), duplicates collapse (sets have no duplicates), and a single add or remove produces a single op.

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
);

engine.delete('$.permissions[1]');

engine.diff();
// [ { op: 'remove', path: `$['permissions'][?@ == "write"]`, value: 'write', identity: 'write' } ]
```

Restricted to primitive items. For sets of objects, add a stable ID field and use `x-key: '<field>'`.

### Reading a keyed array for UI: `items()`

`diff()` answers "what changed" as a flat op list. A list UI needs a different read model: *every* element — including unchanged ones and removed ghosts — labelled with its state. `items()` returns the union of base and draft elements matched by identity:

```ts
engine.items('$.users');
// [
//   { identity: 'a@x.com', path: `$['users'][?@['email'] == "a@x.com"]`,
//     value: { email: 'a@x.com', region: 'us' } },
//   { identity: 'c@x.com', path: `$['users'][?@['email'] == "c@x.com"]`, op: 'replace',
//     value: { email: 'c@x.com', region: 'eu' },
//     changes: [ { op: 'replace', path: "$['region']", oldValue: 'us', value: 'eu' } ] },
//   { identity: 'd@x.com', path: `$['users'][?@['email'] == "d@x.com"]`, op: 'add',
//     value: { email: 'd@x.com', region: 'ap' } },
//   { identity: 'b@x.com', path: `$['users'][?@['email'] == "b@x.com"]`, op: 'remove',
//     value: { email: 'b@x.com', region: 'us' } },
// ]
```

- No `op` — unchanged.
- `add` — present in draft only.
- `remove` — present in base only; `value` carries the base item, ready to render as a ghost row.
- `replace` — present in both with differences; `changes` carries the field-level ops with paths **relative to the item** (identity filters for any nested keyed arrays).

Two handles per entry: `identity` is the data handle (list tracking, display), `path` is the action handle — an engine-built canonical identity path that feeds straight into any op, with quoting/escaping handled:

```ts
engine.delete(row.path);                       // remove this row
engine.replace(`${row.path}['region']`, 'eu'); // edit a field on this row
engine.getBase(row.path);                      // read a ghost's base content
engine.revert(row.path);                       // per-row undo: restore a ghost,
                                               // drop an add, reset a modification
```

Never an index, so it can't go stale when the array is spliced. Draft items come first in draft order, then removed items in base order; reorder freely in the UI.

The identity key comes from the schema's `x-key`, or inline: `engine.items('$.users', { key: 'email' })`. `x-key: '$self'` arrays work too — set semantics, so entries are only ever unchanged / `add` / `remove`.

#### Own vs descendant changes (recursive shapes)

When items have the same keyed shape as their container — a tree of nodes whose `children` array is also keyed — a `replace` entry carries two flags so a tree UI can tell a node that was *itself* edited from one that merely *contains* edited descendants:

- `selfChanged` — at least one change is on this item's own field.
- `descendantsChanged` — at least one change descends into a nested keyed element.

Both can be true. A change to a `$self` set field counts as `descendantsChanged` (a `$self` set is itself a keyed array).

```ts
// node edited its own title only      → { selfChanged: true,  descendantsChanged: false }
// node only contains an edited child   → { selfChanged: false, descendantsChanged: true  }
```

The flags are a convenience over `changes` — `descendantsChanged` is exactly `entry.changes?.some(c => c.identity !== undefined)` — surfaced as fields so the classification lives in one place.

## Scoped lenses

`getNodeEngine(path)` returns a `NodeEngine` — a lens onto a subtree. It owns no state; reads resolve through the parent on every access and writes forward to the parent with paths rewritten. **Both sides see the same physical state.**

```ts
const engine = new Engine({
  cars:   [{ color: 'red' }],
  trucks: [{ color: 'red' }],
});

const cars = engine.getNodeEngine('$.cars');

cars.replace('$[0].color', 'yellow');

engine.draft.cars[0].color;  // 'yellow'
cars.draft[0].color;          // 'yellow'
```

Subtree-scoped behavior on the lens:

- `cars.diff()` — ops touching cars only, paths relative to `$`; each op also carries `absolutePath` with the full document path.
- `cars.accept()` — commits the cars subtree into `base`. The trucks subtree is unaffected.
- `cars.undo()` / `cars.redo()` — delegate to the parent; there is one shared history.

Lenses compose — `getNodeEngine` on a `NodeEngine` joins paths and creates a further-scoped lens against the same root parent.

## LLM integration

`createEngineTools` builds a framework-neutral tool set that any LLM can call to read and edit the draft. The design is intentional: `accept`, `decline`, `undo`, and `redo` are **not** exposed — the LLM writes to draft, the human commits.

```ts
import { createEngineTools } from '@maxjay/patchwork/tools';

const tools = createEngineTools(engine);
// 9 tools: add, replace, delete, move, copy, revert, get, getValue, diff
```

Scope the LLM to a subtree by passing a `NodeEngine`:

```ts
const scoped = engine.getNodeEngine('$.userSettings');
const tools = createEngineTools(scoped);
// the model can only touch userSettings — the rest is unreachable
```

For MCP servers and agentic loops, see [docs/llms.md](docs/llms.md).

## Angular integration

`@maxjay/patchwork/angular` wraps an `Engine` in a reactive store built on Angular Signals (Angular 16+). All reads are exposed as `Signal`s; mutations fire them automatically — no `ChangeDetectorRef`, no `NgZone`.

```ts
import { createPatchworkStore } from '@maxjay/patchwork/angular';

@Component({
  template: `
    <input [value]="port()" (input)="setPort($event)">
    <button (click)="store.accept()" [disabled]="!diff().length">Save</button>
    <button (click)="store.decline()" [disabled]="!diff().length">Discard</button>
  `,
})
class ServerSettings {
  store = createPatchworkStore({ server: { port: 8080 } });
  port  = this.store.getValue<number>('$.server.port');
  diff  = this.store.diff();

  setPort(e: Event) {
    this.store.replace('$.server.port', +(e.target as HTMLInputElement).value);
  }
}
```

See **[docs/angular.md](docs/angular.md)** for the full API, typed generics, change-highlighting UI, ephemeral form binding, scoped sub-stores, and service patterns.

## API

### `Engine<T>`

| Member | Description |
|---|---|
| `new Engine(base, options?)` | Wrap a JSON value. `options.schema` enables identity-based array diffing. |
| `.base` / `.draft` | The committed and working views. |
| `.add(path, value)` | Add or splice. Creates intermediate nodes on literal paths. |
| `.replace(path, value)` | Replace at path. Wildcards replace all matches. |
| `.delete(path)` | Remove at path. |
| `.move(from, to)` | Move. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copy. Source must resolve to exactly one node. |
| `.revert(path)` | Reset draft at path to base. Identity-aware inside keyed arrays. |
| `.get(path)` | `Array<{ path, value }>` — every match in draft with normalized paths. |
| `.getBase(path)` | Same as `get` but reads from base. |
| `.getValue(path)` | Strict single-match read from draft. Throws `Error` on multi-match; throws `undefined` on no-match. |
| `.getValueBase(path)` | Same as `getValue` but reads from base. |
| `.diff(path?, options?)` | `DiffOp[]` — structural diff between base and draft. |
| `.items(path, options?)` | `ItemEntry[]` — merged identity view of a keyed array. |
| `.undo()` / `.redo()` | Reverse / replay the last operation. |
| `.accept()` | Promote draft into base. Reversible. |
| `.decline()` | Reset draft from base. Reversible. |
| `.exportChanges()` | `DiffOp[]` — structural mutations on the undo stack. |
| `.importChanges(ops)` | Apply a `DiffOp[]` stream. |
| `.getNodeEngine<U>(path)` | Scoped lens onto a subtree. |
| `.beginEphemeral()` | Open an ephemeral session. |
| `.commitEphemeral()` | Collapse the session into one undo entry. |
| `.discardEphemeral()` | Unwind the session with no history trace. |

### `NodeEngine<T>`

| Member | Description |
|---|---|
| `.base` / `.draft` | The subtree from parent state. |
| `.add` / `.replace` / `.delete` / `.move` / `.copy` / `.revert` | Mutations forwarded to parent with paths rewritten. |
| `.get(path)` / `.getBase(path)` | Reads draft / base in child frame, forwarded to parent. |
| `.getValue(path)` / `.getValueBase(path)` | Strict single-match reads from draft / base. |
| `.diff(path?, options?)` | Ops touching this subtree. Paths relative to child `$`; each op also carries `absolutePath`. |
| `.items(path, options?)` | Merged identity view of a keyed array under this subtree. |
| `.accept()` | Commits this subtree into parent's base. |
| `.decline()` | Resets this subtree in parent's draft from parent's base. |
| `.undo()` / `.redo()` | Delegate to parent — one shared history. |
| `.getNodeEngine<U>(path)` | Compose a further-scoped lens. |

### `DiffOp`

```ts
type DiffOp =
  | { op: 'add';           path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
  | { op: 'replace';       path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue; identity?: JsonValue }
  | { op: 'remove';        path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
  | { op: 'move' | 'copy'; from: string; to: string }
  | { op: 'revert';        path: string; absolutePath?: string }
```

- `path` — normalized JSONPath (`$['key'][0]`). Inside keyed arrays, a *canonical identity path*: the element segment is a filter on the key (`$['users'][?@['email'] == "b@x.com"]`) — a valid RFC 9535 query that resolves against base or draft and feeds back into any engine op. (Formally not an RFC "Normalized Path"; the RFC's output grammar cannot express identity.)
- `absolutePath` — present on ops from `NodeEngine.diff()`. Contains the full document path while `path` is relative to the child's `$`.
- `identity` — present on ops produced by identity-keyed array diffing. The matched key value (or the item itself for `$self`).
- `oldValue` — present on `replace` ops; the value that was there before.

### `ItemEntry`

```ts
type ItemEntry<V = JsonValue> = {
  identity: JsonValue;                    // data handle: the x-key value (the item itself for $self)
  path: string;                           // action handle: canonical identity path, feeds into any op
  op?: 'add' | 'remove' | 'replace';      // absent = unchanged
  value: V;                               // draft item — base item when op is 'remove'
  changes?: DiffOp[];                     // only on 'replace'; paths relative to the item
  selfChanged?: boolean;                  // only on 'replace'; an own field changed
  descendantsChanged?: boolean;           // only on 'replace'; a nested keyed element changed
}
```

### Entrypoints

```
@maxjay/patchwork          Engine, NodeEngine, DiffOp, ItemEntry, OpType
@maxjay/patchwork/tools    createEngineTools, Tool, EngineLike
@maxjay/patchwork/chat     runAgentLoop, AgentMessage, ModelAdapter, NativeAdapter, PromptAdapter, toAgentTools
@maxjay/patchwork/mcp      toMcpTools, handleMcpCall
@maxjay/patchwork/angular  createPatchworkStore, fromEngine, PatchworkStore
```

---

For deeper coverage of the engine internals, see [docs/engine.md](docs/engine.md).
For LLM integration, adapters, and MCP, see [docs/llms.md](docs/llms.md).
For the Angular Signals adapter, see [docs/angular.md](docs/angular.md).

## Contributors

- [Max](https://github.com/maxjay)
- [Hanqi Zhou](https://github.com/hanqi-zhou)
- [Beth Grant](https://github.com/bethGrant)
- [George Wright](https://github.com/wrightg42)

## License

Apache-2.0
