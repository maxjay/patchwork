# onionskin

Copilot-native JSON editing engine. Give it any JSON object — the engine wraps it in draft layers so every edit is tracked, reviewable, and undoable. Built so an AI copilot and a human user can edit the same document through the same primitives, with the human always in control.

```
JSON document  →  engine (continuous editing)  →  copilot session (proposal layer)
```

## Install

```bash
npm install onionskin
```

## Quick start

Pass any JSON object (or parse one from a string). The engine never mutates your original — all edits are tracked as ops.

```ts
import { Engine } from 'onionskin';

// Any JSON object — could come from a file, an API, user input, wherever
const doc = {
  name: 'My Project',
  settings: { theme: 'light', fontSize: 14 },
  tags: ['draft'],
};

const engine = new Engine(doc);

// Start editing — no session to open, just propose changes
engine.propose({ kind: 'replace', path: '/settings/theme', value: 'dark' });
engine.propose({ kind: 'replace', path: '/settings/fontSize', value: 16 });
engine.propose({ kind: 'add', path: '/tags/-', value: 'v2' });

engine.get('/settings/theme');  // 'dark'

// Review what changed
engine.diff();
// [
//   { path: '/settings/theme', kind: 'replace', value: 'dark', prev: 'light', actor: 'user', ... },
//   { path: '/settings/fontSize', kind: 'replace', value: 16, prev: 14, actor: 'user', ... },
//   { path: '/tags/-', kind: 'add', value: 'v2', actor: 'user', ... },
// ]

// Apply when ready — folds edits into the base, diff resets, undo history survives
engine.apply();
engine.export();
// { name: 'My Project', settings: { theme: 'dark', fontSize: 16 }, tags: ['draft', 'v2'] }

// Keep editing — no need to start a new session
engine.propose({ kind: 'replace', path: '/name', value: 'My Project v2' });
```

Works with any JSON — parsed from a file, fetched from an API, or built in code:

```ts
const fromString = new Engine(JSON.parse('{"key": "value"}'));
const fromApi = new Engine(await fetch('/api/config').then(r => r.json()));
```

## Examples

### Undo and redo

Every change is tracked. Undo and redo work like any editor you've used.

```ts
const engine = new Engine({ color: 'red', size: 10 });

engine.propose({ kind: 'replace', path: '/color', value: 'blue' });
engine.get('/color');  // 'blue'

engine.undo();
engine.get('/color');  // 'red'

engine.redo();
engine.get('/color');  // 'blue'
```

New changes clear the redo stack — just like VS Code, Figma, etc.

```ts
engine.undo();
engine.propose({ kind: 'replace', path: '/size', value: 20 });
engine.redo();  // no-op — redo was cleared by the new change
```

### Undo survives apply

Apply folds your edits into the base and resets the diff — but the undo stack stays. Like pressing save in a document editor.

```ts
const engine = new Engine({ a: 1 });

engine.propose({ kind: 'replace', path: '/a', value: 2 });
engine.apply();

engine.diff();          // [] — diff is clean
engine.get('/a');       // 2
engine.export();        // { a: 2 }

engine.undo();          // undo the apply
engine.undo();          // undo the propose
engine.get('/a');       // 1 — back to original
```

### Revert a specific change

Undo pops from the top. Revert targets a specific path — like clicking the X next to a change in a diff view.

```ts
const engine = new Engine({});

engine.propose({ kind: 'add', path: '/a', value: 1 });
engine.propose({ kind: 'add', path: '/b', value: 2 });
engine.propose({ kind: 'add', path: '/c', value: 3 });

engine.revert('/b');  // removes /b, leaves /a and /c
engine.diff().map(op => op.path);  // ['/a', '/c']
```

### Cascading revert

Reverting a parent automatically reverts its children — they can't exist without it.

```ts
const engine = new Engine({});

engine.propose({ kind: 'add', path: '/address', value: {} });
engine.propose({ kind: 'add', path: '/address/street', value: '123 Main St' });
engine.propose({ kind: 'add', path: '/address/city', value: 'Springfield' });

engine.revert('/address');  // removes /address, /address/street, and /address/city
engine.diff();  // []

engine.undo();  // brings all three back in one step
engine.diff().length;  // 3
```

### Copilot proposals

The copilot edits through a nested session. Its changes are held for review — the user approves or declines each one.

```ts
const engine = new Engine({
  title: 'Quarterly Report',
  author: 'Alice',
  status: 'draft',
  sections: ['intro', 'methodology'],
});

const copilot = engine.startCopilot();

// Copilot proposes some changes
copilot.propose({ kind: 'replace', path: '/title', value: 'Q3 Quarterly Report' });
copilot.propose({ kind: 'replace', path: '/status', value: 'review' });
copilot.propose({ kind: 'add', path: '/sections/-', value: 'conclusion' });

// Review what copilot wants to change
copilot.diff();
// [
//   { path: '/title', value: 'Q3 Quarterly Report', prev: 'Quarterly Report', actor: 'copilot', ... },
//   { path: '/status', value: 'review', prev: 'draft', actor: 'copilot', ... },
//   { path: '/sections/-', value: 'conclusion', actor: 'copilot', ... },
// ]

// Approve some, decline others
copilot.approve('/title');      // folded into engine
copilot.decline('/status');     // dropped — user wants to keep 'draft'
copilot.approve('/sections/-'); // folded into engine

copilot.end();
engine.apply();

engine.export();
// { title: 'Q3 Quarterly Report', author: 'Alice', status: 'draft',
//   sections: ['intro', 'methodology', 'conclusion'] }
```

Or approve/decline everything at once:

```ts
copilot.approveAll();   // folds all pending ops, ends copilot session
// or
copilot.declineAll();   // drops everything, ends copilot session
```

### Conflict detection

When the copilot proposes a change at a path the user has already edited, the diff flags it.

```ts
const engine = new Engine({ title: 'Untitled', priority: 'low' });

// User edits first
engine.propose({ kind: 'replace', path: '/title', value: 'My Document' });

// Copilot proposes into the same path
const copilot = engine.startCopilot();
copilot.propose({ kind: 'replace', path: '/title', value: 'Project Plan' });

copilot.diff();
// [{ path: '/title', value: 'Project Plan', prev: 'My Document', conflictsWithUser: true, ... }]
//                                                                 ^^^^^^^^^^^^^^^^^^^^^^^^
// The UI should warn: "this will overwrite your edit"

copilot.approve('/title');  // user chose to accept — last-write-wins
// or
copilot.decline('/title');  // user chose to keep their value
```

### User is king

When the user edits during an open copilot session, the engine resolves overlaps automatically. The user's action always wins.

```ts
const engine = new Engine({});
const copilot = engine.startCopilot();

// --- Same path: auto-decline ---
copilot.propose({ kind: 'add', path: '/title', value: 'Copilot Title' });
engine.propose({ kind: 'add', path: '/title', value: 'My Title' });
copilot.diff();  // [] — copilot's op was auto-declined

// --- Descendant: auto-accept ---
copilot.propose({ kind: 'add', path: '/metadata', value: { created: '2025-01-01' } });
engine.propose({ kind: 'add', path: '/metadata/author', value: 'Alice' });
// Copilot's /metadata was auto-accepted (user building on it implies acceptance)
// Both /metadata and /metadata/author are now in the engine's op set

// --- Ancestor: auto-decline ---
copilot.propose({ kind: 'add', path: '/options/color', value: 'red' });
engine.propose({ kind: 'add', path: '/options', value: { size: 'large' } });
// Copilot's /options/color was auto-declined (user replaced the whole subtree)

// --- Unrelated: coexist ---
copilot.propose({ kind: 'add', path: '/notes', value: [] });
engine.propose({ kind: 'add', path: '/tags', value: ['important'] });
// No overlap — both stay where they are
```

### Diff tree

`diff()` returns ops in insertion order. `diffTree()` returns the same ops organized as a tree — useful for rendering a grouped review UI.

```ts
const engine = new Engine({});

engine.propose({ kind: 'add', path: '/author/name', value: 'Alice' });
engine.propose({ kind: 'add', path: '/author/email', value: 'alice@example.com' });
engine.propose({ kind: 'add', path: '/metadata/created', value: '2025-01-01' });

const tree = engine.diffTree();
// {
//   children: Map {
//     'author' => {
//       segment: 'author',
//       children: Map {
//         'name'  => { segment: 'name',  op: { path: '/author/name', ... },  children: Map {} },
//         'email' => { segment: 'email', op: { path: '/author/email', ... }, children: Map {} },
//       }
//     },
//     'metadata' => {
//       segment: 'metadata',
//       children: Map {
//         'created' => { segment: 'created', op: { path: '/metadata/created', ... }, children: Map {} },
//       }
//     },
//   }
// }
```

### Version counter

The engine exposes a monotonic version counter that increments on every state change. Use it for reactivity — subscribe to the number, re-read when it changes.

```ts
const engine = new Engine({ a: 1 });
const v0 = engine.version;

engine.propose({ kind: 'replace', path: '/a', value: 2 });
const v1 = engine.version;  // v1 > v0

engine.apply();
const v2 = engine.version;  // v2 > v1
```

Works with any reactive framework:

```ts
// React
const [version, setVersion] = useState(engine.version);
// re-read engine state whenever version changes

// Vue
const version = ref(engine.version);

// Svelte
$: version = engine.version;
```

## API

### `Engine<T>`

| Method | Returns | Description |
|---|---|---|
| `new Engine(base, opts?)` | `Engine<T>` | Create an engine wrapping a JSON object |
| `engine.get(path)` | `unknown` | Read a value through all layers |
| `engine.export()` | `T` | Deep copy of the current effective state |
| `engine.propose(op)` | `void` | Add an op (`add`, `remove`, `replace`) |
| `engine.revert(path)` | `void` | Remove the op at a path (cascades to descendants) |
| `engine.undo()` | `void` | Undo the most recent action |
| `engine.redo()` | `void` | Redo the most recently undone action |
| `engine.diff()` | `Op[]` | Ops in insertion order |
| `engine.diffTree()` | `DiffTreeNode` | Ops organized as a nested tree |
| `engine.apply()` | `void` | Fold ops into the base (diff resets, undo survives) |
| `engine.startCopilot()` | `CopilotSession` | Open a copilot review session |
| `engine.activeCopilotSession()` | `CopilotSession \| null` | The current copilot session, if any |
| `engine.version` | `number` | Monotonic counter, increments on every state change |

### `CopilotSession`

| Method | Returns | Description |
|---|---|---|
| `propose(op)` | `void` | Propose a change for review |
| `revert(path)` | `void` | Remove a proposed op (cascades to descendants) |
| `undo()` | `void` | Undo the most recent action |
| `redo()` | `void` | Redo the most recently undone action |
| `diff()` | `DiffEntry[]` | Proposed ops with `conflictsWithUser` flags |
| `diffTree()` | `DiffTreeNode` | Proposed ops as a nested tree |
| `approve(path)` | `void` | Fold one op into the engine |
| `decline(path)` | `void` | Drop one op |
| `approveAll()` | `void` | Approve all and end session |
| `declineAll()` | `void` | Decline all and end session |
| `end()` | `void` | Close session (unresolved ops are dropped) |

### Op format

```ts
// What you pass to propose():
{ kind: 'add' | 'remove' | 'replace', path: string, value?: unknown }

// What the engine stores and returns in diffs:
{ kind, path, value?, prev?, actor: 'user' | 'copilot', ts: number }
```

Paths are [JSON Pointers](https://datatracker.ietf.org/doc/html/rfc6901) — `/name`, `/settings/theme`, `/items/0`, etc.

## Docs

- [SPEC.md](docs/SPEC.md) — full technical specification
- [DESIGN.md](docs/DESIGN.md) — design decisions and rationale
- [SCENARIOS.md](docs/SCENARIOS.md) — test scenarios as state transitions

## License

ISC
