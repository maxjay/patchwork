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
| `.revert(path)` | Reset draft at path back to whatever `base` has there. |

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

Declare `x-key` on an array schema and patchwork matches elements across `base` and `draft` by that field. One element deleted produces one `remove` op, regardless of what follows it. Field changes on a matched element produce one `replace` op at the element level, with a `changes` array of the individual field-level diffs.

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
// [ { op: 'remove', path: "$['regions'][0]", value: { id: 'us-east', ... }, identity: 'us-east' } ]
// one op — not a cascade

engine.replace('$.regions[0].capacity', 90);
engine.diff();
// [
//   {
//     op: 'replace', path: "$['regions'][0]", identity: 'eu-west',
//     value: { id: 'eu-west', capacity: 90 }, oldValue: { id: 'eu-west', capacity: 80 },
//     displacement: 0,
//     changes: [{ op: 'replace', path: "$['regions'][0]['capacity']", oldValue: 80, value: 90 }]
//   }
// ]
```

`x-key` nests: arrays inside arrays can each declare their own key. By default, field changes in a nested keyed array bubble up and mark the parent element as modified (its `changes` will include them). Pass `cascade: false` to `diff()` to contain changes within their own identity boundary — a nested change will not mark the parent as modified.

The `identity` field on `DiffOp` carries the matched key value, so consumers don't need schema knowledge to identify what was added, removed, or changed.

For a one-off without a schema:

```ts
engine.diff('$.regions', { key: 'id' });
```

### Ordered arrays: `x-ordered`

Add `x-ordered: true` alongside `x-key` to declare that position is meaningful. When an element's index shifts because something was added or removed nearby, patchwork surfaces that as a `move` op — a displacement — rather than hiding it.

```ts
// schema: { 'x-key': 'id', 'x-ordered': true, ... }

engine.delete('$.steps[0]');   // removes step A

engine.diff();
// [
//   { op: 'remove', path: "$['steps'][0]", identity: 'A', value: {...} },
//   { op: 'move',   from: "$['steps'][1]", to: "$['steps'][0]", identity: 'B' },
//   { op: 'move',   from: "$['steps'][2]", to: "$['steps'][1]", identity: 'C' },
// ]
```

`move` ops from identity-keyed arrays carry `identity` so you know which element was displaced. The `displacement` field on `replace` ops tells you how far an element moved when it was also modified.

To restore a displacement, pass the `move` op to `restore()` — it splices the element back to its base position.

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
// [ { op: 'remove', path: "$['permissions'][1]", value: 'write', identity: 'write' } ]
```

Restricted to primitive items. For sets of objects, add a stable ID field and use `x-key: '<field>'`.

### Rendering full lists with `includeUnchanged`

By default `diff()` returns only changed elements. Pass `includeUnchanged: true` to include every element — changed or not — each labelled with its state. This lets you render a complete list with change highlighting from a single call, without merging the diff against the raw array yourself.

```ts
engine.diff('$.regions', { includeUnchanged: true });
// returns add / replace / remove / move ops for changed elements,
// plus { op: 'unchanged', ... } for every element that stayed the same
```

### Reverting a diff op

`restore(op)` takes any `DiffOp` produced by `diff()` and applies the inverse mutation to draft, pushing it onto the undo stack like any other operation. The diff must reflect the current draft state — if you mutate after diffing, re-diff before restoring.

```ts
const ops = engine.diff('$.regions');
const removeOp = ops.find(o => o.op === 'remove' && o.identity === 'us-east');
engine.restore(removeOp);  // re-inserts us-east at its original position
engine.undo();             // un-does the restore
```

| op | what `restore` does |
|---|---|
| `add` | deletes the element |
| `remove` | re-inserts it at its original position |
| `replace` | reverts the element to `oldValue` |
| `move` | splices it back to its base position |

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
| `.revert(path)` | Reset draft at path to base. |
| `.get(path)` | `Array<{ path, value }>` — every match in draft with normalized paths. |
| `.getBase(path)` | Same as `get` but reads from base. |
| `.getValue(path)` | Strict single-match read from draft. Throws `Error` on multi-match; throws `undefined` on no-match. |
| `.getValueBase(path)` | Same as `getValue` but reads from base. |
| `.diff(path?, options?)` | `DiffOp[]` — structural diff between base and draft. `options.key` sets a one-off identity key; `options.includeUnchanged` includes unchanged elements; `options.cascade` (default `true`) controls whether nested identity-array changes bubble up to the parent. |
| `.restore(op)` | Invert a `DiffOp` from `diff()` and push it onto the undo stack. |
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
| `.accept()` | Commits this subtree into parent's base. |
| `.decline()` | Resets this subtree in parent's draft from parent's base. |
| `.undo()` / `.redo()` | Delegate to parent — one shared history. |
| `.getNodeEngine<U>(path)` | Compose a further-scoped lens. |

### `DiffOp`

```ts
type DiffOp =
  | { op: 'add';       path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
  | { op: 'replace';   path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue;
      identity?: JsonValue; displacement?: number; changes?: DiffOp[] }
  | { op: 'remove';    path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
  | { op: 'move';      from: string; to: string; identity?: JsonValue }
  | { op: 'copy';      from: string; to: string }
  | { op: 'revert';    path: string; absolutePath?: string }
  | { op: 'unchanged'; path: string; absolutePath?: string; value: JsonValue; identity: JsonValue; displacement: number }
```

- `path` — normalized JSONPath (`$['key'][0]`).
- `absolutePath` — present on ops from `NodeEngine.diff()`. Contains the full document path while `path` is relative to the child's `$`.
- `identity` — the matched key value for identity-keyed array ops. Present on `add`, `remove`, `move`, and element-level `replace` ops. The item itself for `$self` arrays.
- `oldValue` — present on `replace` ops; the value that was there before.
- `displacement` — on element-level `replace` and `unchanged` ops from ordered arrays (`x-ordered: true`). Integer delta: `draftIndex − baseIndex`. Zero if position did not change.
- `changes` — on element-level `replace` ops. Flat list of field-level `DiffOp`s describing what changed inside the element. Paths are absolute document paths.
- `unchanged` op — only emitted when `diff()` is called with `includeUnchanged: true`.

### Entrypoints

```
@maxjay/patchwork          Engine, NodeEngine, DiffOp, OpType
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
