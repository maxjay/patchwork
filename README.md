<p align="center">
  <h1 align="center">patchwork</h1>
  <p align="center">The editing engine for human-AI collaboration on structured data.</p>
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#why">Why</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#ai-integration">AI integration</a> &middot;
  <a href="#framework-bindings">Frameworks</a> &middot;
  <a href="#api">API</a>
</p>

---

<!-- TODO: Record a demo GIF showing: user edits config, asks AI to "make this production-ready",
     AI proposals appear, user approves some / declines others, undoes an approved change.
     Place it here: ![patchwork demo](demo.gif) -->

## Why

You're building an app where users edit structured data — config files, form builders, workflow definitions, business rules. You want to add AI assistance. Now you need to build:

- Change tracking with full undo/redo
- A proposal layer so the AI can't just overwrite the user's work
- Per-field approve/decline so the user stays in control
- Conflict detection when both human and AI touch the same field
- The glue between your AI and your editor

**That's patchwork.** One primitive that handles all of it.

```
base document  +  user edits  +  copilot proposals  =  current state
                  (always applied)  (held for review)
```

No other library does this. State managers (Redux, Zustand) don't have proposal layers. JSON editors (jsoneditor) are UI components, not engines. CRDTs (Yjs, Automerge) solve multi-user sync, not human-AI review. Patchwork is purpose-built for the moment an AI says *"here's what I'd change"* and a human says *"let me look at that first."*

## Install

```bash
npm install patchwork
```

## How it works

### 1. Wrap any JSON object

```ts
import { Engine } from 'patchwork';

const engine = new Engine({
  appName: 'my-service',
  server: { host: 'localhost', port: 8080 },
  debug: false,
});
```

The engine never mutates your original. Every edit is an op on top.

### 2. Users edit normally

```ts
engine.propose({ kind: 'replace', path: '/server/port', value: 443 });
engine.propose({ kind: 'add', path: '/server/ssl', value: true });
engine.propose({ kind: 'remove', path: '/debug' });

engine.export();
// { appName: 'my-service', server: { host: 'localhost', port: 443, ssl: true } }

engine.undo();   // ssl removed
engine.undo();   // port back to 8080
engine.redo();   // port back to 443
```

Every action — propose, revert, move, apply — is undoable. Just like a real editor.

### 3. AI proposes, human reviews

This is the part nothing else gives you.

```ts
const copilot = engine.startCopilot();

// AI proposes changes — they're held, not applied
copilot.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });
copilot.propose({ kind: 'replace', path: '/server/port', value: 443 });
copilot.propose({ kind: 'add', path: '/server/ssl', value: true });
copilot.propose({ kind: 'add', path: '/logLevel', value: 'warn' });

// each proposal shows what it would change
copilot.diff();
// [
//   { path: '/server/host', kind: 'replace', prev: 'localhost', value: '0.0.0.0' },
//   { path: '/server/port', kind: 'replace', prev: 8080, value: 443 },
//   { path: '/server/ssl', kind: 'add', value: true },
//   { path: '/logLevel', kind: 'add', value: 'warn' },
// ]

// user reviews each one
copilot.approve('/server/port');    // yes, use 443
copilot.approve('/server/ssl');     // yes, add ssl
copilot.decline('/server/host');    // no, keep localhost
copilot.decline('/logLevel');       // no, don't need that

copilot.end();
```

Approved changes land in the user's undo stack — `engine.undo()` rolls back an approved copilot change just like any other edit.

### 4. Simultaneous editing just works

The user doesn't have to stop editing while the AI is proposing. When their edits overlap, patchwork resolves it:

```ts
const copilot = engine.startCopilot();

// AI proposes a new server block
copilot.propose({ kind: 'add', path: '/server/timeout', value: 30 });

// user edits the same area — no crash, no conflict dialog
engine.propose({ kind: 'replace', path: '/server/port', value: 9090 });

// both edits coexist — AI's timeout proposal is still pending,
// user's port change is applied
engine.export();
// { ..., server: { host: 'localhost', port: 9090, timeout: 30 } }
```

When edits collide on the *same path*, the user always wins:

```ts
// AI proposed changing the host
copilot.propose({ kind: 'replace', path: '/server/host', value: '0.0.0.0' });

// user also changes the host — AI proposal auto-accepted, user edit layers on top
engine.propose({ kind: 'replace', path: '/server/host', value: '192.168.1.1' });

// undo goes: user's value -> AI's value -> original
engine.undo();  // back to '0.0.0.0' (AI's proposal)
engine.undo();  // back to 'localhost' (original)
```

### 5. Diff everything

```ts
// what changed from base?
engine.getDiff('/server/port');  // { base: 8080, current: 443 }
engine.getDiff('/appName');      // null (unchanged)

// all pending changes as a flat list
engine.diff();

// or as a tree — for rendering a grouped review UI
engine.diffTree();
// { children: { server: { children: { port: { op: ... }, ssl: { op: ... } } } } }
```

### 6. Apply when ready

`apply()` folds all edits into the base. Diff resets. Undo still works — like pressing save.

```ts
engine.apply();
engine.diff();    // [] — clean
engine.undo();    // undo the apply itself
```

## AI integration

Two layers: **tool definitions** you can plug into any LLM, and a **real MCP server** for native integration with Claude Desktop, Cursor, etc.

### Tool definitions (`patchwork/tools`)

Framework-neutral. Works with Anthropic API, OpenAI API, Vercel AI SDK, local models — anything that supports tool calling.

```ts
import { createEditTools } from 'patchwork/tools';

const tools = createEditTools(engine);
// 11 tools: start_session, end_session, propose, move, get_value,
//           get_diff, approve, decline, approve_all, decline_all, export

// plug into any tool-calling system
for (const tool of tools) {
  server.addTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (input) => tool.handler(input),
  });
}
```

The AI gets tool descriptions that explain the propose-then-review workflow. It calls `start_session`, reads the doc with `get_value`, proposes changes, and the user reviews in your UI.

### MCP server (`patchwork/mcp`)

A real MCP server — JSON-RPC over stdio, connectable from Claude Desktop, Cursor, Claude Code, or any MCP client.

```ts
import { Engine } from 'patchwork';
import { createMcpServer } from 'patchwork/mcp';

const engine = new Engine(loadConfig());
const { server, connect } = createMcpServer(engine);
await connect(); // stdio
```

Exposes all 11 tools plus two resources:
- `config://document` — current state (the AI can read the full doc without a tool call)
- `config://base` — original state before edits

## Framework bindings

Reactive, per-path subscriptions out of the box. A component reading `/server/port` won't re-render when `/server/host` changes.

<table>
<tr><td><b>React</b></td><td><b>Vue</b></td></tr>
<tr>
<td>

```tsx
import { useEngine, useValue }
  from 'patchwork/react';

function PortInput() {
  const engine = useEngine(config);
  const port = useValue<number>(
    engine, '/server/port'
  );

  return <input value={port} />;
}
```

</td>
<td>

```ts
import { useEngine, useValue }
  from 'patchwork/vue';

const { engine } = useEngine(config);
const port = useValue<number>(
  engine, '/server/port'
);

// port.value is reactive
```

</td>
</tr>
<tr><td><b>Svelte</b></td><td><b>Angular</b></td></tr>
<tr>
<td>

```svelte
<script>
import { createEngine, valueStore }
  from 'patchwork/svelte';

const { engine } = createEngine(config);
const port = valueStore(
  engine, '/server/port'
);
</script>

<input value={$port} />
```

</td>
<td>

```ts
import { observeValue }
  from 'patchwork/angular';

// works with async pipe, toSignal()
readonly port = toSignal(
  observeValue(engine, '/server/port')
);
```

No `@angular/core` dep — just `Subscribable`.

</td>
</tr>
</table>

Each binding also exports `useDiff` / `diffStore` / `observeDiff` for per-path diff tracking, and `useExport` / `exportStore` / `observeExport` for the full document.

## API

### `Engine<T>`

| Method | Description |
|---|---|
| `new Engine(base)` | Wrap any JSON object |
| `.get(path)` | Read value (all layers) |
| `.getBase(path)` | Read from base only |
| `.getDiff(path)` | `{ base, current }` or `null` |
| `.export()` | Full state as deep copy |
| `.propose(op)` | `add` / `remove` / `replace` |
| `.move(from, to)` | Rename or relocate (one undo step) |
| `.revert(path)` | Remove op at path + descendants |
| `.undo()` | Undo last action |
| `.redo()` | Redo |
| `.diff()` | Pending ops (flat) |
| `.diffTree()` | Pending ops (tree) |
| `.apply()` | Fold ops into base |
| `.onChange(fn)` | Subscribe; returns unsubscribe fn |
| `.startCopilot()` | Open copilot session |
| `.version` | Monotonic change counter |

### `CopilotSession`

| Method | Description |
|---|---|
| `.propose(op)` | Propose for review |
| `.move(from, to)` | Propose a move |
| `.diff()` | Proposals with `conflictsWithUser` flags |
| `.approve(path)` | Accept one |
| `.decline(path)` | Drop one |
| `.approveAll()` | Accept all + end |
| `.declineAll()` | Drop all + end |
| `.end()` | Close (pending ops dropped) |

### Paths

[JSON Pointers (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) — `/server/port`, `/items/0`, `/-` (append).

### Entrypoints

```
patchwork            Engine, CopilotSession, types, errors
patchwork/tools      Tool definitions for any LLM API
patchwork/mcp        MCP server (JSON-RPC, stdio)
patchwork/react      useEngine, useValue, useDiff, useExport
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
