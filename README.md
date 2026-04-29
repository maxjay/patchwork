<p align="center">
  <h1 align="center">patchwork</h1>
  <p align="center">The editing engine for structured configuration data.</p>
</p>

<p align="center">
  <a href="#motivation">Motivation</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#react">React</a> &middot;
  <a href="#ai-integration">AI integration</a> &middot;
  <a href="#api">API</a>
</p>

---

<!-- TODO: Record a demo GIF showing: user edits config fields, validation errors appear inline,
     the pending-changes panel updates live, undo/redo buttons toggle.
     Place it here: ![patchwork demo](demo.gif) -->

## Motivation

Building a configuration editor, settings panel, or any UI that lets users edit structured data means wiring up everything the real experience needs:

- **What changed?** — Which fields differ from the original, and what were the old values?
- **Is it valid?** — Reject a bad port number before it corrupts the document.
- **Undo/redo** — Not just the last action. The whole session, including through a save.
- **A "review your changes" panel** — Show the user the diff before they commit.

That is four separate systems to build and keep in sync. Patchwork replaces all of them.

You hand it your document and its JSON Schema. Every edit flows through `propose()` — validated immediately, tracked automatically, undoable forever. At any moment you can read `diff()` to see exactly what has changed from the base and render it however you like. One primitive, zero boilerplate.

And if you want to add an AI copilot — an assistant that proposes changes the user reviews before accepting — that is built on the same engine. Same undo stack, same diff, same validation. It is not bolted on.

## Install

```bash
npm install patchwork
```

## How it works

### 1. Wrap any JSON document

Pass a base document and an optional [JSON Schema](https://json-schema.org/). The engine deep-copies your original and never touches it.

```ts
import { Engine } from 'patchwork';

const engine = new Engine(
  {
    appName: 'my-service',
    server: { host: 'localhost', port: 8080 },
    debug: false,
  },
  {
    type: 'object',
    properties: {
      server: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
        },
      },
      debug: { type: 'boolean' },
    },
  },
);
```

### 2. Propose edits — validated, tracked, undoable

Every change is an op. Ops are validated against the schema before they are staged. If the op would produce an invalid document it throws and state is unchanged.

```ts
engine.propose({ kind: 'replace', path: '/server/port', value: 443 });
engine.propose({ kind: 'add',     path: '/server/ssl',  value: true });
engine.propose({ kind: 'remove',  path: '/debug' });

// invalid — throws ValidationError, nothing staged
engine.propose({ kind: 'replace', path: '/server/port', value: 'not-a-port' });
```

### 3. See exactly what changed

`diff()` returns every pending op in the order it was made. `getDiff()` returns the before/after for a single path. Both update the moment you propose or undo.

```ts
engine.diff();
// [
//   { path: '/server/port', kind: 'replace', prev: 8080,  value: 443  },
//   { path: '/server/ssl',  kind: 'add',                  value: true },
//   { path: '/debug',       kind: 'remove',  prev: false              },
// ]

engine.getDiff('/server/port'); // { base: 8080, current: 443 }
engine.getDiff('/appName');     // null — unchanged
```

`diffTree()` returns the same ops organised as a nested tree — useful for building a grouped review panel.

### 4. Validate before committing

`checkValue` is a pure function that tells you whether a value would be valid before you stage it. Use it to drive live input feedback without touching document state.

```ts
const error = engine.checkValue('/server/port', userTypedValue);

if (!error) {
  // valid — show green border
} else {
  error.errors[0].keyword; // 'type', 'minimum', 'maximum', ...
  error.errors[0].message; // 'must be <= 65535'
}
```

### 5. Undo anything

Every propose, revert, move, and apply is a reversible action on the undo stack. Undo history survives `apply()` — pressing save does not erase your undo stack.

```ts
engine.undo();   // removes /server/ssl add
engine.undo();   // reverts /server/port back to 8080
engine.redo();   // port back to 443

engine.apply();  // fold ops into base — diff resets, undo stack lives on
engine.undo();   // undo the apply itself
```

`revert(path)` removes a specific change without touching the rest of the stack — useful for a per-row "discard this change" button in a diff panel.

### 6. Apply when ready

`apply()` folds all pending ops into the base. The diff clears. The undo stack does not. It works exactly like Cmd+S in a document editor.

```ts
engine.apply();
engine.diff();    // [] — clean slate
engine.undo();    // undo the apply — ops come back, diff returns
```

---

## React

Patchwork ships reactive hooks for React 18. Every hook subscribes at the path level — a component reading `/server/port` will not re-render when `/server/host` changes.

```tsx
import {
  useEngine,
  useValue,
  useDiff,
  useNode,
  useExport,
  useCanUndo,
  useCanRedo,
  usePendingDiff,
  useFieldValidation,
} from 'patchwork/react';
```

**Read values**

```tsx
const port    = useValue<number>(engine, '/server/port'); // re-renders only when port changes
const diff    = useDiff(engine, '/server/port');           // { base, current } | null
const node    = useNode(engine, '/server');                // NodeInfo — keys, type, changed
const doc     = useExport(engine);                         // full document, reactive
```

**Drive undo/redo buttons**

```tsx
const canUndo = useCanUndo(engine);
const canRedo = useCanRedo(engine);

<button disabled={!canUndo} onClick={() => engine.undo()}>Undo</button>
<button disabled={!canRedo} onClick={() => engine.redo()}>Redo</button>
```

**Pending changes panel**

```tsx
const pending = usePendingDiff(engine);
// Op[] — every changed path, in proposal order

{pending.map(op => (
  <div key={op.path}>
    <code>{op.path}</code>
    <span>{String(op.prev)} → {String(op.value)}</span>
    <button onClick={() => engine.revert(op.path)}>Discard</button>
  </div>
))}
```

**Inline field validation**

```tsx
function PortField({ engine }) {
  const [draft, setDraft] = useState('');
  const error = useFieldValidation(engine, '/server/port', Number(draft));

  return (
    <>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        style={{ borderColor: error ? 'red' : 'green' }}
        onBlur={() => {
          if (!error) engine.propose({ kind: 'replace', path: '/server/port', value: Number(draft) });
        }}
      />
      {error && <p>{error.errors[0].message}</p>}
    </>
  );
}
```

**Create an engine in a component**

```tsx
// create + subscribe in one call
const engine = useEngine(config, schema);

// or subscribe to an engine you created outside React
useEngineState(engine);
```

---

## Other framework bindings

Reactive, per-path subscriptions in Vue, Svelte, and Angular.

<table>
<tr><td><b>Vue 3</b></td><td><b>Svelte</b></td></tr>
<tr>
<td>

```ts
import { useEngine, useValue }
  from 'patchwork/vue';

const { engine } = useEngine(config, schema);
const port = useValue<number>(
  engine, '/server/port'
);
// port.value is reactive
```

</td>
<td>

```svelte
<script>
import { createEngine, valueStore }
  from 'patchwork/svelte';

const { engine } = createEngine(config, schema);
const port = valueStore(engine, '/server/port');
</script>

<input value={$port} />
```

</td>
</tr>
<tr><td><b>Angular</b></td><td></td></tr>
<tr>
<td>

```ts
import { observeValue }
  from 'patchwork/angular';

// works with async pipe and toSignal()
readonly port = toSignal(
  observeValue(engine, '/server/port')
);
```

No `@angular/core` dep — just `Subscribable`.

</td>
<td></td>
</tr>
</table>

Each binding mirrors the React surface: `useValue`/`valueStore`/`observeValue`, `useDiff`/`diffStore`/`observeDiff`, `useExport`/`exportStore`/`observeExport`.

---

## AI integration

The copilot layer is built on top of the core engine. An AI proposes changes into a separate review layer — they are visible in the UI but not yet in the document. The user approves or declines each one. Approved proposals land in the user's own undo stack, so `engine.undo()` can roll them back like any other edit.

```ts
const copilot = engine.startCopilot();

// AI proposes — changes are held, not applied
copilot.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });
copilot.propose({ kind: 'replace', path: '/server/port', value: 443 });
copilot.propose({ kind: 'add',     path: '/server/ssl',  value: true });

// review the proposals
copilot.diff();
// [
//   { path: '/server/host', kind: 'replace', prev: 'localhost', value: '0.0.0.0' },
//   { path: '/server/port', kind: 'replace', prev: 8080,        value: 443       },
//   { path: '/server/ssl',  kind: 'add',                        value: true      },
// ]

copilot.approve('/server/port');   // accept
copilot.approve('/server/ssl');    // accept
copilot.decline('/server/host');   // reject — keep localhost

copilot.end();
```

The user and the AI can edit simultaneously. When their edits overlap, the user's action always wins ("user is king"). If they edit the same path, the AI proposal is auto-declined. If the user edits a child of an AI-proposed parent, the parent is auto-accepted. The engine resolves it — no conflict dialogs needed.

### Tool definitions (`patchwork/tools`)

Framework-neutral tool definitions that plug into any LLM API (Anthropic, OpenAI, Vercel AI SDK, local models).

```ts
import { createEditTools } from 'patchwork/tools';

const tools = createEditTools(engine);
// 11 tools: start_session, end_session, propose, move, get_value,
//           get_diff, approve, decline, approve_all, decline_all, export
```

### MCP server (`patchwork/mcp`)

A ready-to-connect MCP server over stdio for Claude Desktop, Cursor, Claude Code, or any MCP client.

```ts
import { createMcpServer } from 'patchwork/mcp';

const { server, connect } = createMcpServer(engine);
await connect();
```

Exposes all 11 tools plus two resources:
- `config://document` — current document state
- `config://base` — original document before any edits

---

## API

### `Engine<T>`

| Method / property | Description |
|---|---|
| `new Engine(base, schema?)` | Wrap any JSON object; optional JSON Schema for validation |
| `.propose(op)` | `add` / `remove` / `replace` — throws `ValidationError` if schema rejects |
| `.move(from, to)` | Rename or relocate (one undo step) |
| `.revert(path)` | Remove op at path + descendants (one undo step) |
| `.reset(path)` | Restore path to base value regardless of op structure |
| `.undo()` / `.redo()` | Action-level undo/redo |
| `.canUndo` / `.canRedo` | Boolean — use to drive undo/redo buttons |
| `.diff()` | Pending ops, flat, insertion order |
| `.diffTree()` | Pending ops as nested tree by path |
| `.get(path)` | Current value (all layers) |
| `.getBase(path)` | Value from base only |
| `.getDiff(path)` | `{ base, current }` or `null` |
| `.export()` | Full current state as deep copy |
| `.apply()` | Fold ops into base — diff resets, undo survives |
| `.checkValue(path, value)` | Pure validity check — `null` if valid, `ValidationError` if not |
| `.onChange(fn)` | Subscribe to any change; returns unsubscribe fn |
| `.startCopilot()` | Open a copilot review session |
| `.version` | Monotonic counter — increments on every change |

### `CopilotSession`

| Method | Description |
|---|---|
| `.propose(op)` | Propose for review |
| `.move(from, to)` | Propose a move |
| `.diff()` | Proposals with `conflictsWithUser` flags |
| `.approve(path)` | Accept one proposal |
| `.decline(path)` | Reject one proposal |
| `.approveAll()` | Accept all + close session |
| `.declineAll()` | Reject all + close session |
| `.end()` | Close session (unreviewed proposals are dropped) |

### React hooks (`patchwork/react`)

| Hook | Returns |
|---|---|
| `useEngine(base, schema?)` | `Engine` — creates and subscribes |
| `useEngineState(engine)` | `void` — subscribe an existing engine |
| `useValue<V>(engine, path)` | `V` — reactive value at path |
| `useDiff(engine, path)` | `{ base, current } \| null` |
| `useNode(engine, path)` | `NodeInfo \| null` |
| `useExport<T>(engine)` | `T` — full document |
| `useCanUndo(engine)` | `boolean` |
| `useCanRedo(engine)` | `boolean` |
| `usePendingDiff(engine)` | `Op[]` — all pending changes |
| `useFieldValidation(engine, path, value)` | `ValidationError \| null` |

### Paths

[JSON Pointers (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) — `/server/port`, `/items/0`, `/-` (append to array).

### Entrypoints

```
patchwork            Engine, CopilotSession, types, errors
patchwork/tools      Tool definitions for any LLM API
patchwork/mcp        MCP server (JSON-RPC, stdio)
patchwork/react      useEngine, useValue, useDiff, useNode, useExport,
                     useCanUndo, useCanRedo, usePendingDiff, useFieldValidation
patchwork/vue        useEngine, useValue, useDiff, useExport
patchwork/svelte     createEngine, valueStore, diffStore, exportStore
patchwork/angular    observeValue, observeDiff, observeExport
```

## Docs

- [SPEC.md](docs/SPEC.md) — full specification
- [DESIGN.md](docs/DESIGN.md) — design decisions
- [SCENARIOS.md](docs/SCENARIOS.md) — test scenarios

## License

Apache-2.0
