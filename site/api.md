# API reference

## Engine\<T\>

```ts
import { Engine } from '@maxjay/patchwork'
```

| Member | Description |
|---|---|
| `new Engine(base, options?)` | Wrap a JSON value. `options.schema` enables identity-based array diffing. |
| `.base` / `.draft` | The committed and working views. |
| `.add(path, value)` | Splice into arrays or set on objects. Creates intermediate nodes on literal paths. |
| `.replace(path, value)` | Replace at path. Wildcards replace all matches. |
| `.delete(path)` | Remove at path. Splices arrays in place. |
| `.move(from, to)` | Move a value. Source must resolve to exactly one node. |
| `.copy(from, to)` | Copy a value. Source must resolve to exactly one node. |
| `.revert(path)` | Reset draft at path to base. Accepts queries. |
| `.restore(op)` | Invert a `DiffOp` from `diff()` and push to the undo stack. |
| `.get(path)` | `Array<{ path, value }>` — every match in draft with normalized paths. |
| `.getBase(path)` | Same as `get` but reads from base. |
| `.getValue(path)` | Strict single-match read from draft. Throws on multi-match; throws `undefined` on no-match. |
| `.getValueBase(path)` | Same as `getValue` but reads from base. |
| `.diff(path?, options?)` | `DiffOp[]` — structural diff between base and draft. |
| `.undo()` / `.redo()` | Reverse / replay the last operation. |
| `.accept()` | Promote draft into base. Reversible. |
| `.decline()` | Reset draft from base. Reversible. |
| `.exportChanges()` | `DiffOp[]` — structural mutations on the undo stack. |
| `.importChanges(ops)` | Apply a `DiffOp[]` stream. |
| `.getNodeEngine<U>(path)` | Scoped lens onto a subtree. |
| `.beginEphemeral()` | Open an ephemeral session. |
| `.commitEphemeral()` | Collapse the session into one undo entry. |
| `.discardEphemeral()` | Unwind the session with no history trace. |

### diff() options

```ts
engine.diff(path?, {
  key?: string            // one-off identity key, no schema needed
  includeUnchanged?: boolean  // include unchanged elements (default false)
  cascade?: boolean           // bubble nested identity changes up (default true)
})
```

---

## NodeEngine\<T\>

```ts
const lens = engine.getNodeEngine('$.subtree')
```

| Member | Description |
|---|---|
| `.base` / `.draft` | The subtree from parent state. |
| `.add` / `.replace` / `.delete` / `.move` / `.copy` / `.revert` | Mutations forwarded to parent with paths rewritten. |
| `.get(path)` / `.getBase(path)` | Read draft / base in child frame. |
| `.getValue(path)` / `.getValueBase(path)` | Strict single-match reads. |
| `.diff(path?, options?)` | Ops touching this subtree. Paths relative to `$`; each op also carries `absolutePath`. |
| `.accept()` | Commits this subtree into parent's base. |
| `.decline()` | Resets this subtree in parent's draft from parent's base. |
| `.undo()` / `.redo()` | Delegate to parent — one shared history. |
| `.getNodeEngine<U>(path)` | Compose a further-scoped lens. |

---

## DiffOp

```ts
type DiffOp =
  | { op: 'add';       path: string; absolutePath?: string; value: JsonValue; identity?: JsonValue }
  | { op: 'replace';   path: string; absolutePath?: string; oldValue?: JsonValue; value: JsonValue;
      identity?: JsonValue; displacement?: number; changes?: DiffOp[] }
  | { op: 'remove';    path: string; absolutePath?: string; value?: JsonValue; identity?: JsonValue }
  | { op: 'move';      from: string; to: string; identity?: JsonValue }
  | { op: 'copy';      from: string; to: string }
  | { op: 'revert';    path: string; absolutePath?: string }
  | { op: 'unchanged'; path: string; absolutePath?: string; value: JsonValue;
      identity: JsonValue; displacement: number }
```

| Field | Present on | Description |
|---|---|---|
| `path` | all except `move` / `copy` | Normalized JSONPath (`$['key'][0]`). |
| `absolutePath` | ops from `NodeEngine.diff()` | Full document path; `path` is relative to child's `$`. |
| `identity` | keyed array ops | Matched key value (or the item itself for `$self`). |
| `oldValue` | `replace` | The value before the change. |
| `displacement` | `replace` and `unchanged` from ordered arrays | Integer delta: `draftIndex − baseIndex`. Zero if position unchanged. |
| `changes` | `replace` on keyed array elements | Field-level diffs inside the element. Paths are absolute. |
| `from` / `to` | `move`, `copy` | Source and destination paths. On identity-keyed `move` ops, `from` = base path, `to` = draft path. |

---

## Schema extensions

patchwork extends JSON Schema with two keywords on array nodes:

| Keyword | Values | Effect |
|---|---|---|
| `x-key` | `'<fieldName>'` or `'$self'` | Identity field for matching elements. `$self` for primitive sets. |
| `x-ordered` | `true` | Marks the array as ordered — position shifts are surfaced as `move` ops. |

```json
{
  "type": "array",
  "x-key": "id",
  "x-ordered": true,
  "items": { "type": "object" }
}
```

---

## JSON Patch (RFC 6902)

```ts
import { diffPatch, toJsonPatch, applyJsonPatch, jsonPathToPointer } from '@maxjay/patchwork'
```

| Member | Description |
|---|---|
| `diffPatch(engine, path?, options?)` | Diff an `Engine`/`NodeEngine` and convert the result straight to an RFC 6902 patch document. Shorthand for `toJsonPatch(engine.diff(path, options))`. |
| `toJsonPatch(ops)` | Convert `DiffOp[]` (from `.diff()`) into RFC 6902 `JsonPatchOperation[]` — JSON Pointer (RFC 6901) addressed, standard op vocabulary only. Element-level `replace` ops with `changes` are flattened into field-level ops for a minimal patch. `unchanged` ops are dropped; `revert` ops throw (no RFC 6902 equivalent). |
| `applyJsonPatch(document, patch)` | Apply an RFC 6902 patch document to any JSON value. Pure — `document` is never mutated — and atomic: if any operation fails, a `JsonPatchError` is thrown and nothing is applied. |
| `jsonPathToPointer(path)` | Convert a normalized JSONPath (`$['a'][0]`) to a JSON Pointer (`/a/0`). |

```ts
const engine = new Engine({ server: { port: 8080 } });
engine.replace('$.server.port', 443);

const patch = diffPatch(engine);
// [ { op: 'replace', path: '/server/port', value: 443 } ]

applyJsonPatch(engine.base, patch); // { server: { port: 443 } } — equals engine.draft
```

`applyJsonPatch` implements the full RFC 6902 operation set (`add`, `remove`, `replace`, `move`, `copy`, `test`) against any JSON document — not just ones produced by this engine — so it also accepts patches from other RFC 6902 tooling.

### `JsonPatchOperation`

```ts
type JsonPatchOperation =
  | { op: 'add';     path: string; value: JsonValue }
  | { op: 'remove';  path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move';    path: string; from: string }
  | { op: 'copy';    path: string; from: string }
  | { op: 'test';    path: string; value: JsonValue };
```

### `JsonPatchError`

Thrown by `applyJsonPatch` when an operation fails (bad pointer, missing member, out-of-bounds array index, failed `test`). Carries `index` (the failing operation's position in the patch) and `operation` (the operation itself).

---

## Entrypoints

```
@maxjay/patchwork          Engine, NodeEngine, DiffOp, OpType, diffPatch, toJsonPatch, applyJsonPatch, JsonPatchOperation, JsonPatchError
@maxjay/patchwork/tools    createEngineTools, Tool, EngineLike
@maxjay/patchwork/chat     runAgentLoop, AgentMessage, ModelAdapter, NativeAdapter, PromptAdapter, toAgentTools
@maxjay/patchwork/mcp      toMcpTools, handleMcpCall
@maxjay/patchwork/angular  createPatchworkStore, fromEngine, PatchworkStore
```
