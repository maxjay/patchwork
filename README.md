<p align="center">
  <h1 align="center">patchwork</h1>
  <p align="center">A JSON editing engine with base/draft, diff, undo, ephemeral sessions, and scoped lenses.</p>
</p>

<p align="center">
  <a href="#motivation">Motivation</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#ephemeral-sessions">Ephemeral sessions</a> &middot;
  <a href="#nested-engines">Nested engines</a> &middot;
  <a href="#llm-tools">LLM tools</a> &middot;
  <a href="#api">API</a>
</p>

---

## Motivation

Building a config editor, settings panel, or any UI over structured data means wiring up:

- **What's changed?** — A diff between the saved state and the current edit.
- **Undo/redo** — Across every operation, surviving saves.
- **Review before commit** — Let the user (or you) inspect pending changes before they land.

Patchwork wraps a JSON document in an `Engine` that holds two views — `base` (committed) and `draft` (working) — and a stream of reversible operations. That single primitive covers all three concerns.

Addressing uses [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) throughout — the same standard used by `get`, `replace`, `delete`, and `diff`. Every path you write for a read works identically for a write and vice versa. Diff output follows the [JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902) operation vocabulary (`add`, `replace`, `remove`, `move`, `copy`) so it maps directly onto existing patch tooling and transports.

## Install

```bash
npm install @maxjay/patchwork
```

## How it works

### 1. Wrap any JSON document

Pass any JSON value. The engine takes two independent deep clones — one as `base` (the committed source of truth), one as `draft` (the working copy).

```ts
import { Engine } from '@maxjay/patchwork';

const engine = new Engine({
  server: { host: 'localhost', port: 8080 },
  debug: false,
});

engine.base;   // { server: { host: 'localhost', port: 8080 }, debug: false }
engine.draft;  // identical to base on construction
```

### 2. Mutate the draft

All mutations target `draft`. `base` doesn't move until you `accept()`. Paths are [JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) — the same expressions work for both reads and writes.

```ts
engine.replace('$.server.port', 443);
engine.add('$.server.ssl', true);
engine.delete('$.debug');

engine.draft;
// { server: { host: 'localhost', port: 443, ssl: true } }
engine.base;
// { server: { host: 'localhost', port: 8080 }, debug: false }  — untouched
```

The full mutation surface:

| Method | Description |
|---|---|
| `.add(path, value)` | Set a key or splice into an array. Creates intermediate objects/arrays on literal paths. |
| `.replace(path, value)` | Replace matched values. Supports wildcards — replaces all matches. |
| `.delete(path)` | Remove at path. Shifts arrays in place. |
| `.move(from, to)` | Move a value. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copy a value. Source must resolve to exactly one node. |
| `.revert(path)` | Reset draft at path back to whatever `base` has there. |

```ts
engine.move('$.server.host', '$.host');
// draft: { host: 'localhost', server: { port: 443, ssl: true } }

engine.revert('$.server.port');
// draft: { host: 'localhost', server: { port: 8080, ssl: true } }
// only $.server.port reset — everything else untouched
```

### 3. See exactly what's changed

`diff()` returns a flat list of structural differences between `base` and `draft`, following the [JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902) operation vocabulary. Independent of the undo stack — `diff()` doesn't care how many times you flipped a value.

```ts
engine.diff();
// [
//   { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 },
//   { op: 'add',     path: "$['server']['ssl']",  value: true },
//   { op: 'remove',  path: "$['debug']",          value: false },
// ]
```

Pass a JSONPath to scope the diff to a subtree or expression — useful for targeted change detection without creating a scoped lens:

```ts
engine.diff('$.server');
// [
//   { op: 'replace', path: "$['server']['port']", oldValue: 8080, value: 443 },
//   { op: 'add',     path: "$['server']['ssl']",  value: true },
// ]

engine.diff('$.server.*');          // ops touching any direct child of server
engine.diff('$..*[?@.enabled]');    // ops touching any node with an 'enabled' key
```

Resolves against both `base` and `draft` so deleted nodes are never missed.

#### Identity-based array diffing

By default, arrays are diffed index-by-index. Deleting an element shifts everything that follows, which produces a cascade of false `replace` ops. Declare an `x-key` on array schemas and patchwork matches elements by identity instead:

```ts
const engine = new Engine(
  { outboundMailboxes: [{ id: 'a', name: 'Sales' }, { id: 'b', name: 'Support' }] },
  {
    schema: {
      type: 'object',
      properties: {
        outboundMailboxes: {
          type: 'array',
          'x-key': 'id',          // elements matched by .id across base ↔ draft
          items: { type: 'object' },
        },
      },
    },
  },
);

engine.delete('$.outboundMailboxes[0]');

engine.diff();
// [ { op: 'remove', path: "$['outboundMailboxes'][0]", value: { id: 'a', name: 'Sales' } } ]
// — one op, not a cascade of replacements
```

`x-key` nests: an array inside an array can have its own key field. The engine resolves the right key at each depth automatically.

For a one-off without a schema, pass `key` directly to `diff()`:

```ts
engine.diff('$.outboundMailboxes', { key: 'id' });
```

### 4. Undo anything

Every mutation pushes onto a single linear undo stack. `undo()` reverses; `redo()` replays.

```ts
engine.undo();   // un-revert port
engine.undo();   // un-move host
engine.redo();   // re-move host
```

`accept()` and `decline()` are themselves undoable — pushing save doesn't erase your history.

### 5. Read values

```ts
engine.getValue('$.server.port');  // 443
engine.get('$.server.*');
// [
//   { path: "$['server']['host']", value: 'localhost' },
//   { path: "$['server']['port']", value: 443 },
//   { path: "$['server']['ssl']",  value: true },
// ]
```

- `getValue` is **strict**: throws an `Error` on multi-match, throws `undefined` itself when nothing resolves. Designed for binding to a single field (e.g. an Angular signal or React state).
- `get` always returns `Array<{ path, value }>` — `[]` when nothing matches. The path comes back in normalized form so you can feed it straight into `replace`/`delete`/etc.

### 6. Commit or discard

```ts
engine.accept();
// base ← clone(draft).  base now matches the current draft.

engine.decline();
// draft ← clone(base).  pending edits thrown away.
```

Both are reversible via `undo()`.

### 7. Export & replay history

```ts
const ops = engine.exportChanges();
// DiffOp[] — the typed operations on the undo stack

const replay = new Engine(originalDoc);
replay.importChanges(ops);
// replay.draft is now identical to engine.draft
```

`exportChanges` returns only operations that carry a `DiffOp` descriptor — structural mutations like `add`, `replace`, `delete`, etc. Operations without a descriptor (`accept`, `decline`, ephemeral session commits) are excluded.

## Ephemeral sessions

Some write patterns don't belong on the undo stack — streaming LLM output replacing a field on every chunk, hover previews, keystroke-level form binding. `beginEphemeral` opens a bounded session where mutations proceed normally (individually undoable within the session), and `commitEphemeral` collapses the entire session into one undo entry.

```ts
engine.beginEphemeral();

for await (const chunk of stream) {
  engine.replace('$.response', chunk);  // draft updates live; UI reflects each chunk
}

engine.commitEphemeral();
// draft has the final value; one undo() snaps back to the pre-stream state
```

To cancel instead of commit:

```ts
engine.discardEphemeral();
// draft restored to pre-session state; no history entry, no trace
```

Within the session, `undo()` and `redo()` work on individual steps — you can step back through intermediate values. `undo()` is a no-op at the session boundary so it can't reach pre-session history. On `commitEphemeral`, all session entries are collapsed; on `discardEphemeral`, they're unwound in reverse.

## Nested engines

`getNodeEngine(path)` returns a scoped lens — a child `NodeEngine` rooted at the given subtree. The child owns no state of its own; reads resolve through the parent on every access, and writes forward to the parent with paths rewritten into the parent's frame. **Mutations through either side are visible in both** — they're the same physical state.

```ts
const engine = new Engine({
  cars:   [{ color: 'red' }, { color: 'blue' }],
  trucks: [{ color: 'red' }, { color: 'green' }],
});

const cars = engine.getNodeEngine('$.cars');

cars.replace('$[0].color', 'yellow');

engine.draft.cars[0].color;  // 'yellow' — parent sees it
cars.draft[0].color;          // 'yellow' — child sees it
```

Subtree-scoped behavior on the lens:

- `cars.diff()` returns only ops touching the cars subtree, with paths relative to `$`.
- `cars.accept()` commits **only** the cars subtree into `base`. Trucks-side pending edits stay pending.
- `cars.undo()` and `cars.redo()` delegate to the parent — there's one shared history.

The child stays attached even if the parent reassigns the subtree:

```ts
engine.replace('$.cars', [{ color: 'purple' }]);
cars.draft;  // [{ color: 'purple' }] — still working
```

### Cross-subtree search

Use the parent for queries that span multiple subtrees:

```ts
engine.get('$..*[?@.color == "red"]');
// returns every red — both cars and trucks
```

## LLM tools

`createEngineTools` builds a framework-neutral set of tool definitions an LLM can call. Each tool has a `name`, `description`, JSON Schema `inputSchema`, and an `execute` function bound to the engine you pass in.

```ts
import { createEngineTools } from '@maxjay/patchwork/tools';

const tools = createEngineTools(engine);
// 9 tools: add, replace, delete, move, copy, revert, get, getValue, diff
```

Wrap these for whichever LLM SDK you're using (Anthropic, OpenAI, MCP, etc.) — the core stays SDK-agnostic.

**Scope an LLM to a subtree** by passing a `NodeEngine`:

```ts
const cars = engine.getNodeEngine('$.cars');
const tools = createEngineTools(cars);
// the LLM can only edit cars — trucks are out of reach by construction
```

`accept`, `decline`, `undo`, and `redo` are deliberately **not** exposed as tools. The base/draft split exists so that the AI writes to draft and a human commits — exposing accept to the model would collapse that boundary.

**Ephemeral tools** are opt-in for streaming use cases:

```ts
const tools = createEngineTools(engine, { includeEphemeral: true });
// 11 tools: the base 9 + beginEphemeral, commitEphemeral
```

`discardEphemeral` is not exposed — cancelling a preview is a human decision.

## API

### `Engine<T>`

| Member | Description |
|---|---|
| `new Engine(base)` | Wrap a JSON value. Independent clones taken for `base` and `draft`. |
| `.base` / `.draft` | Public fields. Read either to inspect state. |
| `.add(path, value)` | Splice into arrays, set on objects. Creates intermediate objects/arrays for literal paths. |
| `.replace(path, value)` | Replace the value(s) at path. Supports wildcards. |
| `.delete(path)` | Remove at path. |
| `.move(from, to)` | Move from one path to another. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copy from one path to another. |
| `.revert(path)` | Reset draft at path to whatever base has there. Supports wildcards. |
| `.get(path)` | `Array<{ path, value }>` — every match in draft, with normalized paths. |
| `.getValue(path)` | Strict single-match read. Throws `Error` on multi-match; throws `undefined` on no-match. |
| `.diff(path?, options?)` | `DiffOp[]` — structural diff between base and draft. Optional JSONPath scopes the result. Pass `{ key: 'id' }` to enable identity-based array diffing for that path. |
| `.undo()` / `.redo()` | Reverse / replay the last operation. |
| `.accept()` | Promote draft into base. Reversible. |
| `.decline()` | Reset draft from base. Reversible. |
| `.exportChanges()` | `DiffOp[]` — structural mutations on the undo stack. Excludes accept/decline/ephemeral commits. |
| `.importChanges(ops)` | Apply a `DiffOp[]` stream. |
| `.getNodeEngine<U>(path)` | Scoped lens onto a subtree. Throws if path doesn't resolve to exactly one node. |
| `.beginEphemeral()` | Open an ephemeral session. Mutations push to the stack normally but will be collapsed on commit. |
| `.commitEphemeral()` | Close the session, collapsing all session entries into one undo/redo entry. |
| `.discardEphemeral()` | Close the session, unwinding all session mutations with no history trace. |

### `NodeEngine<T>`

| Member | Description |
|---|---|
| `.base` / `.draft` | Read the subtree from the parent's state. |
| `.add` / `.replace` / `.delete` / `.move` / `.copy` / `.revert` | Mutations forwarded to parent with paths rewritten. |
| `.get(path)` / `.getValue(path)` | Reads resolved in child frame, forwarded to parent. |
| `.diff(path?, options?)` | Ops touching this subtree only. `path` is relative to the child's `$`; each op also carries `absolutePath` with the full document path. |
| `.accept()` | Commits this subtree into parent's base. Other subtrees unaffected. |
| `.decline()` | Resets this subtree in parent's draft from parent's base. |
| `.undo()` / `.redo()` | Delegate to parent — there is one shared history. |
| `.getNodeEngine<U>(path)` | Compose a further-scoped lens by joining paths. |

`NodeEngine` does not have `exportChanges`, `importChanges`, `beginEphemeral`, `commitEphemeral`, or `discardEphemeral`.

### `DiffOp`

Diff output follows the [JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902) operation vocabulary:

```ts
type DiffOp =
  | { op: 'add';            path: string; value: JsonValue }
  | { op: 'replace';        path: string; oldValue?: JsonValue; value: JsonValue }
  | { op: 'remove';         path: string; value?: JsonValue }
  | { op: 'move' | 'copy';  from: string; to: string }
  | { op: 'revert';         path: string }
```

Paths are always in normalized JSONPath form (`$['key'][0]`). `OpType` is an enum exported from the main entrypoint with string values matching the `op` field (`OpType.Add = 'add'`, etc.).

### `createEngineTools(engine, options?)` *(from `@maxjay/patchwork/tools`)*

Returns 9 `Tool` objects (`add`, `replace`, `delete`, `move`, `copy`, `revert`, `get`, `getValue`, `diff`). Pass `{ includeEphemeral: true }` to append `beginEphemeral` and `commitEphemeral`. Accepts any `EngineLike` — both `Engine` and `NodeEngine` satisfy it structurally.

```ts
interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: object;             // JSON Schema
  execute(input: TInput): TOutput;
}
```

### Paths

[JSONPath (RFC 9535)](https://datatracker.ietf.org/doc/html/rfc9535) via [`jsonpath-rfc9535`](https://www.npmjs.com/package/jsonpath-rfc9535). The same path expression works for reads, writes, and diffs. Examples:

- `$.server.port` — literal member access
- `$.items[2]` — literal index
- `$.items[*]` — all array elements
- `$..*` — recursive descent, every node
- `$..*[?@.color == "red"]` — recursive descent with filter expression

### Entrypoints

```
@maxjay/patchwork         Engine, NodeEngine, DiffOp, OpType
@maxjay/patchwork/tools   createEngineTools, Tool, EngineLike
```

## Contributors

- [Max](https://github.com/maxjay)
- [Hanqi Zhou](https://github.com/hanqi-zhou)
- [Beth Grant](https://github.com/bethGrant)
- [George Wright](https://github.com/wrightg42)

## License

Apache-2.0
