# onionskin

Copilot-native editing engine for JSON. Every edit is tracked, reviewable, and undoable. An AI copilot and a human can edit the same document through the same primitives — the human is always in control.

```
base document  +  user ops  +  copilot ops  =  current state
```

## Install

```bash
npm install onionskin
```

## 30-second overview

```ts
import { Engine } from 'onionskin';

const engine = new Engine({ host: 'localhost', port: 8080, debug: false });

// edit
engine.propose({ kind: 'replace', path: '/port', value: 443 });
engine.propose({ kind: 'add', path: '/ssl', value: true });

// read
engine.get('/port');    // 443
engine.diff();          // [{ path: '/port', kind: 'replace', prev: 8080, value: 443, ... }, ...]
engine.export();        // { host: 'localhost', port: 443, debug: false, ssl: true }

// undo / redo
engine.undo();
engine.redo();

// move / rename
engine.move('/host', '/hostname');

// save — folds ops into base, undo still works
engine.apply();
```

## Copilot

The copilot edits through a proposal layer. Its changes are held for review — the user approves or declines each one.

```ts
const copilot = engine.startCopilot();

copilot.propose({ kind: 'replace', path: '/port', value: 443 });
copilot.propose({ kind: 'add', path: '/ssl', value: true });
copilot.propose({ kind: 'remove', path: '/debug' });

// review
copilot.diff();
// [
//   { path: '/port', value: 443, prev: 8080, conflictsWithUser: false },
//   { path: '/ssl', value: true, conflictsWithUser: false },
//   { path: '/debug', prev: false, conflictsWithUser: false },
// ]

// approve some, decline others
copilot.approve('/port');
copilot.approve('/ssl');
copilot.decline('/debug');   // user wants to keep debug

copilot.end();
```

When the user edits a path the copilot also touched, the engine resolves it automatically — user always wins:

| Overlap | What happens |
|---|---|
| Same path | Copilot op auto-accepted, user edit layers on top |
| User edits child of copilot path | Copilot op auto-accepted (user is building on it) |
| User edits parent of copilot path | Copilot op auto-declined (user replaced the subtree) |
| No overlap | Both coexist |

## Framework bindings

Reactive, per-path subscriptions. A component reading `/port` won't re-render when `/host` changes.

### React

```tsx
import { useEngine, useValue, useDiff, useExport } from 'onionskin/react';

function App() {
  const engine = useEngine({ host: 'localhost', port: 8080 });

  const port = useValue<number>(engine, '/port');       // only re-renders when port changes
  const diff = useDiff(engine, '/port');                 // { base, current } | null
  const config = useExport(engine);                      // full document
}
```

### Vue

```ts
import { useEngine, useValue, useDiff, useExport } from 'onionskin/vue';

const { engine } = useEngine({ host: 'localhost', port: 8080 });

const port = useValue<number>(engine, '/port');          // ComputedRef<number>
const diff = useDiff(engine, '/port');                    // ComputedRef<{ base, current } | null>
const config = useExport(engine);                         // ComputedRef<T>
```

### Svelte

```svelte
<script>
  import { createEngine, valueStore, exportStore } from 'onionskin/svelte';

  const { engine } = createEngine({ host: 'localhost', port: 8080 });

  const port = valueStore<number>(engine, '/port');      // Readable<number>
  const config = exportStore(engine);                     // Readable<T>
</script>

<input value={$port} />
```

### Angular

```ts
import { observeValue, observeExport } from 'onionskin/angular';

// works with async pipe, toSignal(), or RxJS from()
readonly port = toSignal(observeValue<number>(engine, '/port'));
readonly config = toSignal(observeExport(engine));
```

No `@angular/core` dependency — just a `Subscribable` interface.

## AI integration

Two layers: **tool definitions** for any LLM API, and a **real MCP server** for native integration.

### Tool definitions

Framework-neutral tool definitions you can plug into any LLM tool-calling system — Anthropic API, OpenAI API, Vercel AI SDK, or a local model.

```ts
import { createEditTools } from 'onionskin/tools';

const tools = createEditTools(engine);
// 11 tools: start_session, propose, move, get_value, get_diff,
//           approve, decline, approve_all, decline_all, end_session, export

// wire into any tool-calling API
for (const tool of tools) {
  registerTool({
    name: tool.name,
    description: tool.description,
    schema: tool.inputSchema,
    handler: (input) => tool.handler(input),
  });
}
```

### MCP server

A proper MCP server — JSON-RPC over stdio, tools + resources. Connectable from Claude Desktop, Cursor, Claude Code, or any MCP client.

```ts
import { Engine } from 'onionskin';
import { createMcpServer } from 'onionskin/mcp';

const engine = new Engine(loadConfig());
const { server, connect } = createMcpServer(engine);

await connect(); // stdio transport
```

Exposes:
- **11 tools** — the full editing toolkit
- **2 resources** — `config://document` (current state), `config://base` (original)

## API

### `Engine<T>`

| Method | Description |
|---|---|
| `new Engine(base)` | Create engine wrapping any JSON object |
| `.get(path)` | Read value at path (all layers) |
| `.getBase(path)` | Read value from base only (pre-edits) |
| `.getDiff(path)` | `{ base, current }` if changed, `null` if not |
| `.export()` | Full current state as deep copy |
| `.propose(op)` | Add / remove / replace at a path |
| `.move(from, to)` | Move or rename a field (one undo step) |
| `.revert(path)` | Remove the op at a path (cascades to children) |
| `.undo()` | Undo last action |
| `.redo()` | Redo last undone action |
| `.diff()` | All pending ops |
| `.diffTree()` | Ops as a nested tree (for grouped UI) |
| `.apply()` | Fold ops into base (undo survives) |
| `.onChange(fn)` | Subscribe to changes, returns unsubscribe |
| `.startCopilot()` | Open a copilot review session |
| `.version` | Monotonic counter, increments on every change |

### `CopilotSession`

| Method | Description |
|---|---|
| `.propose(op)` | Propose a change for review |
| `.move(from, to)` | Propose a move/rename |
| `.diff()` | Pending proposals with `conflictsWithUser` flags |
| `.approve(path)` | Accept one proposal |
| `.decline(path)` | Drop one proposal |
| `.approveAll()` | Accept all, end session |
| `.declineAll()` | Drop all, end session |
| `.end()` | Close session (pending ops dropped) |

### Paths

[JSON Pointers (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) — `/name`, `/server/port`, `/items/0`, `/-` (append to array).

### Entrypoints

| Import | What |
|---|---|
| `onionskin` | Engine, CopilotSession, types, errors |
| `onionskin/tools` | Tool definitions for any LLM API |
| `onionskin/mcp` | MCP server (JSON-RPC, stdio) |
| `onionskin/react` | `useEngine`, `useValue`, `useDiff`, `useExport` |
| `onionskin/vue` | `useEngine`, `useValue`, `useDiff`, `useExport` |
| `onionskin/svelte` | `createEngine`, `valueStore`, `diffStore`, `exportStore` |
| `onionskin/angular` | `observeValue`, `observeDiff`, `observeExport` |

## Docs

- [SPEC.md](docs/SPEC.md) — full specification
- [DESIGN.md](docs/DESIGN.md) — design decisions
- [SCENARIOS.md](docs/SCENARIOS.md) — test scenarios

## License

ISC
