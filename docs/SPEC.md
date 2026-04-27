# Technical Specification

*A TypeScript library for session-based, copilot-native JSON editing*

---

## 1. Purpose

A Node.js / TypeScript library that wraps a JSON configuration object behind a session-based editing API. Consumers never mutate the config directly — all changes flow through **edit sessions** that act as draft layers over the base config. The library is built to be "copilot-native": an AI copilot (via MCP or otherwise) operates through the same primitives as a human user, but its proposed changes are held in a nested review layer that the user explicitly approves or declines.

The library ships in two packages:

1. **Core engine** — the session model, ops, diffs, undo, export.
2. **MCP toolkit** — helpers and pre-built tool definitions that let developers expose any engine instance through their own MCP server.

---

## 2. Goals & non-goals

### Goals
- Drive all edits through an API layer — no direct mutation of the config.
- Support layered drafts: base → user draft → copilot draft.
- Make copilot proposals reviewable in isolation (approve / decline, per-op or bulk).
- Support undo/redo at two granularities: whole session, and individual operation, with cascading revert down path hierarchies.
- Expose diffs at each layer so a UI can render "my changes" separately from "copilot's proposed changes" — including conflict flags where user and copilot edits overlap.
- Provide a toolkit for standing up an MCP server over the engine.
- Stay in-memory; allow the final config to be exported.

### Non-goals (v0)
- Schema validation. The hook exists; the implementation is deferred to v1.
- Persistence. No disk, no DB, no session hydration.
- Concurrent copilot proposals. Only one copilot sub-session at a time.
- Server-side multi-user concurrency. v0 assumes a browser-local deployment — one human, one engine instance. Multi-user conflict resolution (optimistic locking, CRDT, etc.) is deferred to v2.
- Shipping a ready-made MCP server binary.

### Deployment model (v0)

The engine is designed to run **in-browser, local to a single user**. One human is editing through one engine instance at a time. Multiple tabs or multiple tenants are handled by constructing multiple engine instances, not by sharing one engine across sessions. This is what justifies several simplifications elsewhere in the spec (one user session per engine, no locking, in-memory only).

---

## 3. Core concepts

### 3.1 The base config

An arbitrary JSON-serializable object provided at engine construction. Treated as immutable by the engine — it is never mutated in place. The effective "current" config is computed by folding committed sessions over the base.

### 3.2 Sessions

A **session** is a draft layer: an ordered set of operations that have not yet been folded into the base.

Two session types, same primitives:

- **User session.** Owned by the human. At most one open at a time (per engine instance — scoping beyond that is the host's concern). Ops authored by the user go here directly.
- **Copilot session.** Always nested inside an open user session. Represents a single batch of proposed changes from the copilot, pending user review.

**Nesting rule:** one copilot session active at a time. Sequential copilot sessions within a single user session are fine — the user can ask, review, approve, then ask again. Concurrent copilot proposals are explicitly out of scope.

### 3.3 Operations

Every change is a discrete, addressable **op**. Ops are modeled on RFC 6902 (JSON Patch) but extended with actor, timestamp, and a captured previous value for reverts.

```ts
type Op = {
  path: string;                            // RFC 6901 JSON Pointer
  kind: 'add' | 'remove' | 'replace';
  value?: unknown;                          // present for add/replace
  prev?: unknown;                           // captured at propose-time for revert
  actor: 'user' | 'copilot';
  ts: number;
};
```

**Identity rule:** within a given session, an op is identified by its **path**. At most one active op per path per session. Proposing a second op at the same path supersedes the first (the first is shadowed, not deleted from history — see §3.5).

### 3.4 Layered read model

`engine.get(path)` resolves by walking layers top-down:

```
copilot session (if open) → user session (if open) → base config
```

The first layer with an active op at that path wins. If no layer has touched it, the base value is returned. This is what makes diffs cheap: each layer holds only its own deltas.

### 3.5 Undo / redo semantics

Two granularities:

**Session-level.** `session.discard()` throws away the entire session's ops. `session.commit()` folds them down into the layer below.

**Op-level.** `session.undo()` reverts the most recent action in the session. `session.redo()` re-applies the most recently undone action. `session.revert(path)` removes the currently-active op at a specific path (used when the UI wants a "remove this one change" button next to a value, rather than a global undo button).

**Actions, not ops.** The undo and redo stacks hold **actions**, not individual ops. An action is one reversible unit of work, which may contain one or many ops. Undo inverts the whole action as a group; redo re-applies it as a group. This matters because some single user gestures touch multiple paths — see §3.9 for the full treatment.

**Stacks are per-session.** Each session — user or copilot — owns its own undo and redo stacks. Undoing in the copilot session does not touch user edits, and vice versa. This keeps actor boundaries clean.

**Redo invalidation.** Any new action on a session clears that session's redo stack. This matches standard editor behavior: once you branch history by making a new change, the previously-undone future no longer exists.

**Shadowed ops.** If the user proposes `replace /foo = 1`, then `replace /foo = 2`, the first op is shadowed by the second. `revert('/foo')` removes the *latest* (value = 2); the path returns to the value from the layer below, not to the shadowed op. This matches the stated constraint: "User can't revert op 2, because op 4 is on top in that session." `undo()` has the same effect in this case, since the latest action is the one being undone.

### 3.6 Diffs

Each session computes its diff against the layer directly beneath it:

- `userSession.diff()` → ops vs. base.
- `copilotSession.diff()` → ops vs. the current user session state.

**Ordering.** `diff()` returns ops in **insertion order** — the order in which they were proposed. This is the simplest model, aligns with undo/redo ordering, and is what most UIs want for a timeline-style review pane.

For UIs that want a subtree-grouped view (e.g. Git-style "all changes under `/database`"), the library also provides `diffTree()`, which returns the same ops organized as a nested tree by path. Two methods, two use cases, both derived from the same underlying op list. This is a framework — it gives callers both primitives and lets them choose.

**Conflict indicator on copilot diffs.** Each entry in `copilotSession.diff()` may carry a `conflictsWithUser: boolean` flag. It's set in the specific case where the user has already edited an overlapping path (equal or related by ancestry/descent) *before* the copilot proposed — i.e. the copilot is walking into territory the user already touched. The flag is advisory: approval still proceeds last-write-wins, but the UI should surface a warning so the user doesn't clobber their own earlier work by reflex.

Note that in the **reverse** direction — where the user edits after copilot has already proposed — the engine takes automatic action (auto-accept or auto-decline per §3.7), so no flag is needed in that case.

```ts
type DiffEntry = Op & { conflictsWithUser?: boolean };
```

Only copilot diff entries carry this flag. User diffs are against the base, which by definition can't "conflict" — the user is the primary actor.

### 3.7 Copilot review flow

When a copilot session is open:

- `copilotSession.propose(op)` adds to the copilot layer.
- `copilotSession.diff()` is what the user reviews.
- `copilotSession.approve(path)` folds that single op down into the user session and removes it from the copilot layer.
- `copilotSession.decline(path)` drops that op with no effect.
- `copilotSession.approveAll()` / `declineAll()` are bulk shortcuts.
- The copilot session **stays open** until the user explicitly calls `end()` (or `approveAll` / `declineAll`, which implicitly end it once everything is resolved). Per-op approve/decline does not close the session. This lets the user approve some, ask the copilot for more changes, review again, and so on, within a single copilot review.

Approval is **per-op**, not per-session. Whole-session accept/decline are conveniences over the per-op primitive.

**User edits during an open copilot session — the "user is king" rules.**

While a copilot session is open, the user can still edit directly through the user session. When they do, the engine reacts based on the path relationship between the user's edit and any pending copilot ops. The guiding principle: **the user is the primary actor**. Their direct actions take precedence, and the engine infers the right resolution for each path relationship.

| Relation (copilot op vs. user's new edit) | Interpretation | Automatic action |
|---|---|---|
| Same path | User overriding copilot's value | **Auto-decline** copilot op |
| User edits a **descendant** of copilot's op | User is building on copilot's structure — they couldn't edit `/server/port` unless they accepted `/server` | **Auto-accept** copilot op (fold into user layer) |
| User edits an **ancestor** of copilot's op | User is replacing the whole subtree | **Auto-decline** copilot op (and cascade to any other copilot ops inside that subtree) |
| Unrelated paths | No relationship | Coexist, no action |

Auto-accept and auto-decline are recorded on the **user session's** undo stack as separate actions from the user's own edit, so undo can peel them back independently:

- Auto-accept pushes the folded copilot op onto the user stack first (so `undo()` reverses the user's edit; a second `undo()` reverses the auto-accepted fold).
- Auto-decline simply removes the copilot op from the copilot layer — no stack entry needed, since decline is a drop, not an inverse-able mutation.

**Reverse direction (copilot proposes at a path the user has already touched).** The copilot op is kept, but the diff entry is marked `conflictsWithUser: true` (see §3.6). No automatic resolution fires — copilot does not get to override user edits implicitly. The user decides on approve (last-write-wins if they approve) or decline.

### 3.8 Commit & export

- `userSession.commit()` folds all user-layer ops into the base. After commit, `engine.export()` returns the resulting object.
- `engine.export()` returns a deep copy of the current effective config (base + any committed sessions). Safe to serialize.
- The engine stays in memory; nothing is persisted automatically.

### 3.9 Path relationships & cascading revert

Ops can be related by path. Understanding these relationships is necessary for revert, undo, and conflict detection to behave intuitively.

**Relationships.** Given two ops at paths P1 and P2:
- **Equal** — same path.
- **Ancestor/descendant** — one path is a prefix of the other (e.g. `/a` is an ancestor of `/a/b/c`).
- **Unrelated** — neither is a prefix of the other.

**Containment rule.** If a session has ops at both `/a` and `/a/b`, the child op's meaningful existence depends on the parent. Removing the parent must remove the child — otherwise the child points at a path that no longer exists.

**Cascading revert.** `session.revert(path)` removes:
1. The active op at `path` itself.
2. Every active op at a descendant of `path`, in the same session.

All removed ops are grouped together as **one action** on the undo stack. This matters for redo: a single `undo()` brings the whole group back in one step.

**Undo is not a cascade.** `session.undo()` pops the most recent action from the stack and inverts it. If that action was a propose of a single op, one op comes off. If it was a cascading revert of three ops, all three come back together. The stack handles grouping; undo itself doesn't inspect relationships.

**Worked example.**

| Step | Action                  | Ops after step                   | Undo stack                                  | Redo stack |
|------|-------------------------|----------------------------------|---------------------------------------------|------------|
| 1    | `propose add /a = {}`   | `/a`                             | `[A1: add /a]`                              | `[]`       |
| 2    | `propose add /a/b = 5`  | `/a`, `/a/b`                     | `[A1, A2: add /a/b]`                        | `[]`       |
| 3    | `revert('/a')`          | (none)                           | `[A1, A2, A3: revert {/a, /a/b}]`           | `[]`       |
| 4    | `undo()`                | `/a`, `/a/b`                     | `[A1, A2]`                                  | `[A3]`     |
| 5    | `undo()`                | `/a`                             | `[A1]`                                      | `[A3, A2]` |
| 6    | `undo()`                | (none)                           | `[]`                                        | `[A3, A2, A1]` |
| 7    | `redo()`                | `/a`                             | `[A1]`                                      | `[A3, A2]` |

At step 4, one `undo` restores *both* `/a` and `/a/b` because they were removed together in action A3. Redo is the symmetric operation.

**Ancestor ops cannot be reverted while leaving descendants.** Reverting `/a` always takes `/a/b` with it. The reverse isn't true: reverting `/a/b` alone is fine and leaves `/a` untouched.

**Implementation note.** Op inversion uses the `value` and `prev` fields captured at propose-time. No additional bookkeeping beyond grouping ops into actions on the stack.

### 3.10 Array handling

Arrays need special treatment because their elements have no natural identity — positional indices shift on insert/remove, which breaks path-as-identity. Ops referencing `/items/2` may mean different things before and after an unrelated `/items/0` removal.

**Principle.** The engine speaks JSON Patch (RFC 6901 / RFC 6902) at its public surface — ops reference array elements by index. Internally, every array element carries a stable key that persists across inserts, removes, and reorders. The engine translates between the two at the API boundary.

**Internal representation.** When the engine sees an array (during construction, propose, or fold), each element is assigned a stable key (an opaque string — UUID, nanoid, or monotonic counter, choice is an implementation detail). The array is tracked internally as an ordered collection of `(key, value)` pairs. Key assignment is idempotent: the same element retains its key across the session's lifetime.

**External representation.** `engine.get(path)` and `engine.export()` return plain JSON. Arrays come back as arrays, in order. Callers never see keys.

**Op translation at the boundary.** When an op arrives with an index-based path (e.g. `replace /items/2`), the engine resolves index 2 to the key currently at order-position 2 and stores the op internally against that key. From that point on, the op is immune to position shifts caused by other ops in the same session.

**What this fixes.** Consider: base is `[1, 2, 3]`.
- `remove /items/1` — removes the element at position 1 (value `2`).
- `replace /items/1 = 99` — in a naive positional model, this would now target the `3`. In the keyed model, the `replace` at propose-time resolves to the key of the element now at position 1 (formerly at position 2), i.e. the `3`'s key. Revert of the `replace` restores `3`. Revert of the `remove` restores `2` at its original order-position. Both ops remain independently reversible.
- Array ordering is recovered from keys + order metadata on export.

**Ops on array elements.** All three core kinds work:
- `add /items/-` — append. Engine assigns a new key.
- `add /items/N` — insert at position N. Engine assigns a new key, other keys keep their order.
- `replace /items/N` — replace the element at the current position N. The op targets the key.
- `remove /items/N` — remove the element at the current position N by key. Splice semantics: remaining elements' positions shift down in the exported array, but their keys (and the ops targeting them) are unaffected.

**Why this isn't a departure from JSON Patch.** The external contract is still RFC 6902. Callers emit standard JSON Patch; the engine exports standard JSON. Keyed identity is an internal implementation detail with an adapter at the boundary. Consumers who speak JSON Patch (including LLMs trained on it) do not need to know about keys.

**Cascading revert on arrays.** Descendants of array element paths (e.g. `/items/2/name`) still cascade correctly because they resolve to the key-scoped path internally. Reverting an array element's path removes any descendant ops targeting that element.

**Export format.** Plain JSON array, elements in order. Keys are stripped at the export boundary.

---

## 4. Public API (shape)

> Illustrative — names may shift during implementation.

```ts
class Engine<T = unknown> {
  constructor(base: T, opts?: EngineOptions<T>);
  get(path: string): unknown;
  startUserSession(): UserSession;
  activeUserSession(): UserSession | null;
  export(): T;
  readonly version: number;  // increments on every state change; UIs subscribe to this for reactivity
}

interface EngineOptions<T> {
  validate?: (next: T) => void;  // v0: hook exists, unused; v1: schema layer
}

// Session IDs are internal only in v0. The engine holds at most one user
// session and one copilot session at a time, so the caller always knows
// which session they're talking to by context. IDs may be exposed in v2
// when multi-session support lands.

class UserSession {
  propose(op: Op | Op[]): void;
  revert(path: string): void;    // cascades to descendants; throws if path untouched
  undo(): void;
  redo(): void;
  diff(): Op[];                  // insertion order
  diffTree(): DiffTreeNode;      // same ops, organized as nested tree by path
  startCopilot(): CopilotSession;
  activeCopilotSession(): CopilotSession | null;
  commit(): void;
  discard(): void;
}

class CopilotSession {
  propose(op: Op | Op[]): void;
  revert(path: string): void;    // cascades to descendants; throws if path untouched
  undo(): void;
  redo(): void;
  diff(): DiffEntry[];           // insertion order, with conflictsWithUser flags
  diffTree(): DiffTreeNode;
  approve(path: string): void;
  decline(path: string): void;
  approveAll(): void;
  declineAll(): void;
  end(): void;
}
```

---

## 5. MCP toolkit (separate package)

Not a server — a **toolkit** for building one. Ships:

- Pre-built MCP tool definitions (name, description, JSON schema for inputs) for the standard operations: `start_user_session`, `start_copilot_session`, `propose_patch`, `get_diff`, `revert_op`, `approve_op`, `decline_op`, `approve_all`, `decline_all`, `commit`, `discard`, `get_value`, `export`.
- Handlers that bind those tool calls to an `Engine` instance the developer constructs.
- An adapter interface that's neutral over MCP server frameworks (official SDK, fastmcp, etc.) — the developer brings the server, the toolkit brings the tools.

**Intended usage (sketch):**

```ts
import { Engine } from 'json-edit-engine';
import { createEditTools } from 'json-edit-engine-mcp';

const engine = new Engine(myConfig);
const tools = createEditTools(engine);

// developer registers `tools` with their MCP server of choice
```

The toolkit assumes the copilot drives the engine by emitting JSON Patch-shaped ops, because that matches what LLMs are already good at producing.

---

## 6. Invariants & edge cases

- **Base immutability.** The base object passed to the constructor is never mutated. Commits produce a new effective state internally.
- **One user session at a time** per engine instance. Multiple tabs or tenants construct separate engine instances.
- **One copilot session at a time** within a user session. Sequential copilot sessions are fine; concurrent ones are not supported.
- **One active op per path** within a session. Repeated proposes on the same path supersede.
- **Revert of an untouched path throws.** Calling `revert(path)` on a path with no active op in the session throws `NoOpAtPathError`. Silent no-ops hide caller bugs (stale UI state, typos). Callers who genuinely want "revert if present" can catch and ignore.
- **Revert cascades to descendants.** Reverting `/a` removes every active op at descendant paths in the same session, grouped as one action on the undo stack.
- **Per-session undo/redo stacks, action-based.** Each stack entry is an action — one reversible unit that may contain one or many ops. Undo inverts the whole action; redo re-applies it. New actions clear that session's redo stack. Sessions do not share stacks.
- **Copilot auto-resolution on user edit.** When the user edits during an open copilot session, the engine automatically resolves overlapping copilot ops: same-path → auto-decline; descendant (user edits below copilot's path) → auto-accept copilot op into user layer; ancestor (user edits above, replacing the subtree) → auto-decline copilot op (cascading to any copilot ops inside). Unrelated paths coexist.
- **Conflict flag only for the reverse direction.** `conflictsWithUser: true` flags a copilot op proposed at a path the user has already touched. In that direction, no automatic resolution fires — the user decides on approve.
- **Session IDs are internal.** v0 holds at most one user + one copilot session; callers don't need IDs to disambiguate.
- **Export is a deep copy.** No reference leaks to the engine's internal state.
- **Arrays are keyed internally, indexed externally.** The public API accepts and returns plain JSON (arrays are arrays). Internally, every array element is assigned a stable key so ops can reference elements by identity rather than position. Index-based paths in incoming ops are translated to key-based references at propose-time. This is an implementation detail behind an adapter — callers work with JSON Patch-style paths and never see the keys. See §3.10.

---

## 7. Versioning plan

- **v0** — everything above: session model, nested copilot sessions, action-based undo/redo, cascading revert, conflict indicator and auto-decline rules, insertion-order diffs + diffTree, keyed-array internal representation, version counter for reactivity, implicit parent creation on `add`, MCP toolkit, in-memory export. Schema validation stubbed. Op kinds limited to `add` / `remove` / `replace`.
- **v1** — schema validation layer (JSON Schema or Zod adapter) wired into the `validate` hook; ops rejected at propose-time if they would produce an invalid state. Also: first-class `move` op (likely trivial given keyed array representation — it's just a reorder).
- **v2** — server-side deployment: multi-user concurrency, conflict resolution across committed user sessions, optimistic locking or CRDT-style merging, session serialization/hydration, public session IDs. Batch propose with atomic semantics.
- **Later** — richer MCP toolkit surface (resources, not just tools). Event emitter in addition to version counter if reactive frameworks prove to want push rather than pull.

---

## 8. Resolved design decisions

The initial open questions have been resolved as follows — recorded here so the rationale isn't lost:

1. **Revert of an untouched path.** Throws `NoOpAtPathError`. Silent no-ops hide caller bugs.
2. **Session IDs.** Internal only in v0. One user + one copilot session at a time means context is unambiguous. Revisit in v2 when multi-session lands.
3. **Op ordering in `diff()`.** Insertion order by default. `diffTree()` added as a separate method for subtree-grouped views. Framework provides both primitives; UI chooses.
4. **Copilot session lifecycle.** Stays open until explicit `end()` (or `approveAll` / `declineAll`). Per-op approve/decline does not close the session — the user can approve some, ask for more, review again.
5. **Array / move / copy ops.** Only `add`, `remove`, `replace` in v0. `move` and `copy` deferred to post-v2; they require tracking key identity across paths and complicate revert semantics.

Additional decisions recorded during spec review:

6. **User edits during copilot session — "user is king."** Auto-decline on same path (override); **auto-accept** on descendant (user building on copilot's structure, implies acceptance); auto-decline on ancestor with cascade (user replacing the whole subtree). Unrelated paths coexist. The reverse direction (copilot proposes into user-touched territory) never auto-resolves — it flags `conflictsWithUser: true` and leaves the decision to the user on approve.
7. **Undo/redo stacks hold actions, not ops.** A cascading revert of 3 ops is one action; one `undo()` brings all 3 back.
8. **Cascading revert.** Reverting a path also reverts all descendant ops in the same session, grouped into one action.
