# onionskin

Session-based, copilot-native JSON editing engine. All changes flow through draft layers — never mutate your config directly. Built so an AI copilot and a human user can edit the same object through the same primitives, with the human always in control.

```
base config  →  user session (draft)  →  copilot session (proposal)
```

## Install

```bash
npm install onionskin
```

## Quick start

```ts
import { Engine } from 'onionskin';

const engine = new Engine({
  database: { host: 'localhost', port: 5432 },
  cache: { ttl: 60 },
});

// Start editing
const session = engine.startUserSession();

session.propose({ kind: 'replace', path: '/database/host', value: 'prod.db' });
session.propose({ kind: 'replace', path: '/cache/ttl', value: 300 });

engine.get('/database/host');  // 'prod.db'
engine.get('/cache/ttl');      // 300

// Review what changed
session.diff();
// [
//   { path: '/database/host', kind: 'replace', value: 'prod.db', prev: 'localhost', actor: 'user', ... },
//   { path: '/cache/ttl', kind: 'replace', value: 300, prev: 60, actor: 'user', ... },
// ]

// Commit when ready
session.commit();
engine.export();  // { database: { host: 'prod.db', port: 5432 }, cache: { ttl: 300 } }
```

## Examples

### Undo and redo

Every change is tracked. Undo and redo work like any editor you've used.

```ts
const engine = new Engine({ color: 'red', size: 10 });
const session = engine.startUserSession();

session.propose({ kind: 'replace', path: '/color', value: 'blue' });
engine.get('/color');  // 'blue'

session.undo();
engine.get('/color');  // 'red'

session.redo();
engine.get('/color');  // 'blue'
```

New changes clear the redo stack — just like VS Code, Figma, etc.

```ts
session.undo();
session.propose({ kind: 'replace', path: '/size', value: 20 });
session.redo();  // no-op — redo was cleared by the new change
```

### Revert a specific change

Undo pops from the top. Revert targets a specific path — like clicking the X next to a change in a diff view.

```ts
const engine = new Engine({});
const session = engine.startUserSession();

session.propose({ kind: 'add', path: '/a', value: 1 });
session.propose({ kind: 'add', path: '/b', value: 2 });
session.propose({ kind: 'add', path: '/c', value: 3 });

session.revert('/b');  // removes /b, leaves /a and /c
session.diff().map(op => op.path);  // ['/a', '/c']
```

### Cascading revert

Reverting a parent automatically reverts its children — they can't exist without it.

```ts
const engine = new Engine({});
const session = engine.startUserSession();

session.propose({ kind: 'add', path: '/server', value: {} });
session.propose({ kind: 'add', path: '/server/host', value: 'localhost' });
session.propose({ kind: 'add', path: '/server/port', value: 8080 });

session.revert('/server');  // removes /server, /server/host, and /server/port
session.diff();  // []

session.undo();  // brings all three back in one step
session.diff().length;  // 3
```

### Copilot proposals

The copilot edits through a nested session. Its changes are held for review — the user approves or declines each one.

```ts
const engine = new Engine({
  timeout: 30,
  retries: 3,
  logLevel: 'warn',
});

const session = engine.startUserSession();
const copilot = session.startCopilot();

// Copilot proposes some changes
copilot.propose({ kind: 'replace', path: '/timeout', value: 60 });
copilot.propose({ kind: 'replace', path: '/retries', value: 5 });
copilot.propose({ kind: 'replace', path: '/logLevel', value: 'debug' });

// Review what copilot wants to change
copilot.diff();
// [
//   { path: '/timeout', value: 60, prev: 30, actor: 'copilot', ... },
//   { path: '/retries', value: 5, prev: 3, actor: 'copilot', ... },
//   { path: '/logLevel', value: 'debug', prev: 'warn', actor: 'copilot', ... },
// ]

// Approve some, decline others
copilot.approve('/timeout');   // folded into user session
copilot.approve('/retries');   // folded into user session
copilot.decline('/logLevel');  // dropped

copilot.end();
session.commit();

engine.export();  // { timeout: 60, retries: 5, logLevel: 'warn' }
```

Or approve/decline everything at once:

```ts
copilot.approveAll();   // folds all pending ops into user session, ends copilot session
// or
copilot.declineAll();   // drops everything, ends copilot session
```

### Conflict detection

When the copilot proposes a change at a path the user has already edited, the diff flags it.

```ts
const engine = new Engine({ timeout: 30 });
const session = engine.startUserSession();

// User edits first
session.propose({ kind: 'replace', path: '/timeout', value: 45 });

// Copilot proposes into the same territory
const copilot = session.startCopilot();
copilot.propose({ kind: 'replace', path: '/timeout', value: 60 });

copilot.diff();
// [{ path: '/timeout', value: 60, prev: 45, conflictsWithUser: true, ... }]
//                                            ^^^^^^^^^^^^^^^^^^^^^^^^
// The UI should warn: "this will overwrite your edit"

copilot.approve('/timeout');  // user chose to accept — last-write-wins
// or
copilot.decline('/timeout');  // user chose to keep their value
```

### User is king

When the user edits during an open copilot session, the engine resolves overlaps automatically. The user's action always wins.

```ts
const engine = new Engine({});
const session = engine.startUserSession();
const copilot = session.startCopilot();

// --- Same path: auto-decline ---
copilot.propose({ kind: 'add', path: '/timeout', value: 60 });
session.propose({ kind: 'add', path: '/timeout', value: 45 });
copilot.diff();  // [] — copilot's op was auto-declined

// --- Descendant: auto-accept ---
// (new copilot session)
copilot.propose({ kind: 'add', path: '/server', value: { host: 'x' } });
session.propose({ kind: 'add', path: '/server/port', value: 8080 });
// Copilot's /server was auto-accepted (user building on it implies acceptance)
// Both /server and /server/port are now in the user session

// --- Ancestor: auto-decline ---
copilot.propose({ kind: 'add', path: '/db/port', value: 5432 });
session.propose({ kind: 'add', path: '/db', value: { host: 'prod' } });
// Copilot's /db/port was auto-declined (user replaced the whole subtree)

// --- Unrelated: coexist ---
copilot.propose({ kind: 'add', path: '/cache', value: {} });
session.propose({ kind: 'add', path: '/logging', value: {} });
// No overlap — both stay where they are
```

### Diff tree

`diff()` returns ops in insertion order. `diffTree()` returns the same ops organized as a tree — useful for rendering a grouped review UI.

```ts
const engine = new Engine({});
const session = engine.startUserSession();

session.propose({ kind: 'add', path: '/database/host', value: 'prod.db' });
session.propose({ kind: 'add', path: '/database/port', value: 5432 });
session.propose({ kind: 'add', path: '/cache/ttl', value: 300 });

const tree = session.diffTree();
// {
//   children: Map {
//     'database' => {
//       segment: 'database',
//       children: Map {
//         'host' => { segment: 'host', op: { path: '/database/host', ... }, children: Map {} },
//         'port' => { segment: 'port', op: { path: '/database/port', ... }, children: Map {} },
//       }
//     },
//     'cache' => {
//       segment: 'cache',
//       children: Map {
//         'ttl' => { segment: 'ttl', op: { path: '/cache/ttl', ... }, children: Map {} },
//       }
//     },
//   }
// }
```

### Multiple sessions over time

Sessions are sequential. Commit one, start another. Each builds on the last.

```ts
const engine = new Engine({ version: 1 });

const s1 = engine.startUserSession();
s1.propose({ kind: 'add', path: '/feature', value: 'dark-mode' });
s1.commit();

const s2 = engine.startUserSession();
s2.propose({ kind: 'replace', path: '/version', value: 2 });
s2.commit();

engine.export();  // { version: 2, feature: 'dark-mode' }
```

### Discard

Changed your mind? Discard throws everything away.

```ts
const engine = new Engine({ clean: true });
const session = engine.startUserSession();

session.propose({ kind: 'replace', path: '/clean', value: false });
engine.get('/clean');  // false

session.discard();
engine.get('/clean');  // true — as if the session never happened
```

### Version counter

The engine exposes a monotonic version counter that increments on every state change. Use it for reactivity — subscribe to the number, re-read when it changes.

```ts
const engine = new Engine({ a: 1 });
const v0 = engine.version;

const session = engine.startUserSession();
const v1 = engine.version;  // v1 > v0

session.propose({ kind: 'replace', path: '/a', value: 2 });
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
| `new Engine(base, opts?)` | `Engine<T>` | Create an engine with a base config |
| `engine.get(path)` | `unknown` | Read a value through all layers |
| `engine.export()` | `T` | Deep copy of the current effective config |
| `engine.startUserSession()` | `UserSession` | Open a new editing session |
| `engine.activeUserSession()` | `UserSession \| null` | The current session, if any |
| `engine.version` | `number` | Monotonic counter, increments on every state change |

### `UserSession`

| Method | Returns | Description |
|---|---|---|
| `propose(op)` | `void` | Add an op (`add`, `remove`, `replace`) |
| `revert(path)` | `void` | Remove the op at a path (cascades to descendants) |
| `undo()` | `void` | Undo the most recent action |
| `redo()` | `void` | Redo the most recently undone action |
| `diff()` | `Op[]` | Ops in insertion order |
| `diffTree()` | `DiffTreeNode` | Ops organized as a nested tree |
| `startCopilot()` | `CopilotSession` | Open a copilot review session |
| `activeCopilotSession()` | `CopilotSession \| null` | The current copilot session, if any |
| `commit()` | `void` | Fold ops into the base and close the session |
| `discard()` | `void` | Drop all ops and close the session |

### `CopilotSession`

| Method | Returns | Description |
|---|---|---|
| `propose(op)` | `void` | Propose a change for review |
| `revert(path)` | `void` | Remove a proposed op (cascades to descendants) |
| `undo()` | `void` | Undo the most recent action |
| `redo()` | `void` | Redo the most recently undone action |
| `diff()` | `DiffEntry[]` | Proposed ops with `conflictsWithUser` flags |
| `diffTree()` | `DiffTreeNode` | Proposed ops as a nested tree |
| `approve(path)` | `void` | Fold one op into the user session |
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

Paths are [JSON Pointers](https://datatracker.ietf.org/doc/html/rfc6901) — `/database/host`, `/items/0`, etc.

## Docs

- [SPEC.md](docs/SPEC.md) — full technical specification
- [DESIGN.md](docs/DESIGN.md) — design decisions and rationale
- [SCENARIOS.md](docs/SCENARIOS.md) — test scenarios as state transitions

## License

ISC
