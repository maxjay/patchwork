# Technical Specification

*A TypeScript library for copilot-native JSON editing*

---

## 1. Purpose

A Node.js / TypeScript library that wraps a JSON object behind a continuous editing API. Consumers never mutate the object directly — all changes flow through **ops** (operations) that the engine tracks, diffs, and can undo. The library is built to be "copilot-native": an AI copilot (via MCP or otherwise) operates through the same primitives as a human user, but its proposed changes are held in a nested review layer that the user explicitly approves or declines.

The library ships in two packages:

1. **Core engine** — the editing model, ops, diffs, undo, export.
2. **MCP toolkit** — helpers and pre-built tool definitions that let developers expose any engine instance through their own MCP server.

---

## 2. Goals & non-goals

### Goals
- Drive all edits through an API layer — no direct mutation of the JSON object.
- Support a continuous editing experience: the user is always editing, with no session open/close lifecycle.
- Support a nested copilot proposal layer for AI-assisted editing with per-op review.
- Support undo/redo at individual operation granularity, with cascading revert down path hierarchies.
- Undo history survives `apply()` — the user can undo edits that have already been folded into the base, just like Cmd+S in a document editor doesn't erase your undo stack.
- Expose diffs so a UI can render "my changes" separately from "copilot's proposed changes" — including conflict flags where user and copilot edits overlap.
- Provide a toolkit for standing up an MCP server over the engine.
- Stay in-memory; allow the current state to be exported at any time.

### Non-goals (v0)
- Schema validation. The hook exists; the implementation is deferred to v1.
- Persistence. No disk, no DB.
- Concurrent copilot proposals. Only one copilot session at a time.
- Server-side multi-user concurrency. v0 assumes a browser-local deployment — one human, one engine instance. Multi-user conflict resolution (optimistic locking, CRDT, etc.) is deferred to v2.
- Shipping a ready-made MCP server binary.

### Deployment model (v0)

The engine is designed to run **in-browser, local to a single user**. One human editing through one engine instance at a time. Multiple tabs or multiple tenants are handled by constructing multiple engine instances, not by sharing one. This justifies the simplifications elsewhere in the spec (no locking, in-memory only).

---

## 3. Core concepts

### 3.1 The base

An arbitrary JSON-serializable object provided at engine construction. The engine deep-copies it on construction and never mutates the caller's original. The base is updated when the user calls `apply()` — pending ops are folded into it, resetting the diff while preserving undo history.

### 3.2 Continuous editing model

There is no user session to open or close. The engine is always ready for edits. The user calls `engine.propose(op)` directly — the engine tracks every op, maintains undo/redo stacks, and computes diffs against the base.

The only session concept that remains is the **copilot session** — a nested proposal layer that the user explicitly opens and closes. This is inherently transactional because the copilot's changes need review before they enter the user's edit history.

### 3.3 Operations

Every change is a discrete, addressable **op**. Ops are modeled on RFC 6902 (JSON Patch) but extended with actor, timestamp, and a captured previous value for reverts.

```ts
// What the caller provides:
type OpInput = {
  path: string;                            // RFC 6901 JSON Pointer
  kind: 'add' | 'remove' | 'replace';
  value?: unknown;                          // present for add/replace
};

// What the engine stores:
type Op = {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  value?: unknown;
  prev?: unknown;                           // captured at propose-time for revert
  actor: 'user' | 'copilot';               // set by the engine, not the caller
  ts: number;
};
```

The `actor` and `ts` fields are set by the engine based on which method was called — the caller never provides them. `actor` is `'user'` for `engine.propose()` and `'copilot'` for `copilotSession.propose()`.

**Identity rule:** at most one active op per path. Proposing a second op at the same path supersedes the first (the first is shadowed, not deleted from history — see §3.5).

### 3.4 Layered read model

`engine.get(path)` resolves by walking layers top-down:

```
copilot session (if open) → engine ops → base
```

The first layer with an active op at that path wins. If no layer has touched it, the base value is returned. This is what makes diffs cheap: each layer holds only its own deltas.

### 3.5 Undo / redo semantics

Two mechanisms:

**`engine.undo()`** — reverses the most recent action. `engine.redo()` re-applies the most recently undone action.

**`engine.revert(path)`** — removes the currently-active op at a specific path (used when the UI wants a "remove this one change" button next to a value, rather than a global undo button).

**Actions, not ops.** The undo and redo stacks hold **actions**, not individual ops. An action is one reversible unit of work, which may contain one or many ops. Undo inverts the whole action as a group; redo re-applies it as a group. This matters because some single user gestures touch multiple paths — see §3.9 for the full treatment.

**Separate stacks for engine and copilot.** The engine owns its own undo/redo stacks. Each copilot session owns its own pair. Undoing in the copilot session does not touch user edits, and vice versa. This keeps actor boundaries clean.

**Redo invalidation.** Any new action clears the redo stack. This matches standard editor behavior: once you branch history by making a new change, the previously-undone future no longer exists.

**Shadowed ops.** If the user proposes `replace /foo = 1`, then `replace /foo = 2`, the first op is shadowed by the second. `revert('/foo')` removes the *latest* (value = 2); the path returns to the value from the base, not to the shadowed op. `undo()` is different — it pops the most recent action, which can restore the shadowed op as the active one.

### 3.6 Diffs

Diffs are computed against the layer directly beneath:

- `engine.diff()` → user's pending ops vs. base.
- `copilotSession.diff()` → copilot's ops vs. the current engine state (base + user ops).

**Ordering.** `diff()` returns ops in **insertion order** — the order in which they were proposed. This is the simplest model, aligns with undo/redo ordering, and is what most UIs want for a timeline-style review pane.

For UIs that want a subtree-grouped view (e.g. Git-style "all changes under `/author`"), the library also provides `diffTree()`, which returns the same ops organized as a nested tree by path. Two methods, two use cases, both derived from the same underlying op list.

**Conflict indicator on copilot diffs.** Each entry in `copilotSession.diff()` may carry a `conflictsWithUser: boolean` flag. It's set when the user has already edited an overlapping path (equal or related by ancestry/descent) *before* the copilot proposed — i.e. the copilot is walking into territory the user already touched. The flag is advisory: approval still proceeds last-write-wins, but the UI should surface a warning so the user doesn't clobber their own earlier work by reflex.

Note that in the **reverse** direction — where the user edits after copilot has already proposed — the engine takes automatic action (auto-accept or auto-decline per §3.7), so no flag is needed in that case.

```ts
type DiffEntry = Op & { conflictsWithUser?: boolean };
```

Only copilot diff entries carry this flag. Engine diffs are against the base, which by definition can't "conflict" — the user is the primary actor.

### 3.7 Copilot review flow

When a copilot session is open:

- `copilotSession.propose(op)` adds to the copilot layer.
- `copilotSession.diff()` is what the user reviews.
- `copilotSession.approve(path)` folds that single op into the engine's op set and removes it from the copilot layer.
- `copilotSession.decline(path)` drops that op with no effect.
- `copilotSession.approveAll()` / `declineAll()` are bulk shortcuts.
- The copilot session **stays open** until the user explicitly calls `end()` (or `approveAll` / `declineAll`, which implicitly end it once everything is resolved). Per-op approve/decline does not close the session.

Approval is **per-op**, not per-session. Whole-session accept/decline are conveniences over the per-op primitive.

**`end()` drops unresolved ops.** Calling `end()` closes the copilot session and discards any copilot ops that haven't been approved or declined.

**User edits during an open copilot session — the "user is king" rules.**

While a copilot session is open, the user can still edit directly through `engine.propose()`. When they do, the engine reacts based on the path relationship between the user's edit and any pending copilot ops. The guiding principle: **the user is the primary actor**. Their direct actions take precedence.

| Relation (copilot op vs. user's new edit) | Interpretation | Automatic action |
|---|---|---|
| Same path | User overriding copilot's value | **Auto-decline** copilot op |
| User edits a **descendant** of copilot's op | User is building on copilot's structure — they couldn't edit `/server/port` unless they accepted `/server` | **Auto-accept** copilot op (fold into engine) |
| User edits an **ancestor** of copilot's op | User is replacing the whole subtree | **Auto-decline** copilot op (and cascade to any other copilot ops inside that subtree) |
| Unrelated paths | No relationship | Coexist, no action |

Auto-accept and auto-decline are recorded on the **engine's** undo stack as separate actions from the user's own edit, so undo can peel them back independently:

- Auto-accept pushes the folded copilot op onto the engine stack first (so `undo()` reverses the user's edit; a second `undo()` reverses the auto-accepted fold).
- Auto-decline simply removes the copilot op from the copilot layer — no stack entry needed, since decline is a drop, not an inversible mutation.

**Reverse direction (copilot proposes at a path the user has already touched).** The copilot op is kept, but the diff entry is marked `conflictsWithUser: true` (see §3.6). No automatic resolution fires — copilot does not get to override user edits implicitly. The user decides on approve (last-write-wins if they approve) or decline.

### 3.8 Apply & export

- `engine.apply()` folds all pending user ops into the base. The diff resets to empty, but the **undo stack is preserved** — the user can undo through an apply boundary. Calling `apply()` while a copilot session is open throws `CopilotSessionOpenError`. Calling `apply()` with no pending ops is a no-op.
- `engine.export()` returns a deep copy of the current effective state (base + pending ops + copilot ops if any). Safe to serialize.
- The engine stays in memory; nothing is persisted automatically.

**Undo after apply.** When the user undoes an apply action, the engine reverses the base change (using captured `prev` values) and restores the ops to the active set. The user can then continue undoing individual ops. This gives the experience of a continuous undo history that isn't broken by "save" operations.

### 3.9 Path relationships & cascading revert

Ops can be related by path. Understanding these relationships is necessary for revert, undo, and conflict detection to behave intuitively.

**Relationships.** Given two ops at paths P1 and P2:
- **Equal** — same path.
- **Ancestor/descendant** — one path is a prefix of the other (e.g. `/a` is an ancestor of `/a/b/c`).
- **Unrelated** — neither is a prefix of the other.

**Containment rule.** If the engine has ops at both `/a` and `/a/b`, the child op's meaningful existence depends on the parent. Removing the parent must remove the child — otherwise the child points at a path that no longer exists.

**Cascading revert.** `engine.revert(path)` removes:
1. The active op at `path` itself.
2. Every active op at a descendant of `path`.

All removed ops are grouped together as **one action** on the undo stack. This matters for redo: a single `undo()` brings the whole group back in one step.

**Undo is not a cascade.** `engine.undo()` pops the most recent action from the stack and inverts it. If that action was a propose of a single op, one op comes off. If it was a cascading revert of three ops, all three come back together. The stack handles grouping; undo itself doesn't inspect relationships.

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

**Internal representation.** When the engine sees an array (during construction, propose, or fold), each element is assigned a stable key (an opaque string — UUID, nanoid, or monotonic counter, choice is an implementation detail). The array is tracked internally as an ordered collection of `(key, value)` pairs. Key assignment is idempotent: the same element retains its key across the engine's lifetime.

**External representation.** `engine.get(path)` and `engine.export()` return plain JSON. Arrays come back as arrays, in order. Callers never see keys.

**Op translation at the boundary.** When an op arrives with an index-based path (e.g. `replace /items/2`), the engine resolves index 2 to the key currently at order-position 2 and stores the op internally against that key. From that point on, the op is immune to position shifts caused by other ops.

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

  // Read
  get(path: string): unknown;
  export(): T;
  readonly version: number;  // increments on every state change; UIs subscribe to this for reactivity

  // Edit
  propose(op: OpInput | OpInput[]): void;
  revert(path: string): void;    // cascades to descendants; throws if path untouched
  undo(): void;
  redo(): void;

  // Diff
  diff(): Op[];                  // insertion order
  diffTree(): DiffTreeNode;      // same ops, organized as nested tree by path

  // Apply
  apply(): void;                 // fold ops into base; diff resets, undo survives

  // Copilot
  startCopilot(): CopilotSession;
  activeCopilotSession(): CopilotSession | null;
}

interface EngineOptions<T> {
  validate?: (next: T) => void;  // v0: hook exists, unused; v1: schema layer
}

class CopilotSession {
  propose(op: OpInput | OpInput[]): void;
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

- Pre-built MCP tool definitions (name, description, JSON schema for inputs) for the standard operations: `start_copilot_session`, `propose_patch`, `get_diff`, `revert_op`, `approve_op`, `decline_op`, `approve_all`, `decline_all`, `apply`, `get_value`, `export`.
- Handlers that bind those tool calls to an `Engine` instance the developer constructs.
- An adapter interface that's neutral over MCP server frameworks (official SDK, fastmcp, etc.) — the developer brings the server, the toolkit brings the tools.

**Intended usage (sketch):**

```ts
import { Engine } from 'onionskin';
import { createEditTools } from 'onionskin-mcp';

const engine = new Engine(myDoc);
const tools = createEditTools(engine);

// developer registers `tools` with their MCP server of choice
```

The toolkit assumes the copilot drives the engine by emitting JSON Patch-shaped ops, because that matches what LLMs are already good at producing.

---

## 6. Invariants & edge cases

- **Base immutability at the boundary.** The base object passed to the constructor is deep-copied. The caller's original is never mutated. Internally, the base is updated by `apply()`.
- **One copilot session at a time.** Sequential copilot sessions are fine; concurrent ones are not supported.
- **One active op per path.** Repeated proposes on the same path supersede.
- **Revert of an untouched path throws.** Calling `revert(path)` on a path with no active op throws `NoOpAtPathError`. Silent no-ops hide caller bugs (stale UI state, typos). Callers who genuinely want "revert if present" can catch and ignore.
- **Revert cascades to descendants.** Reverting `/a` removes every active op at descendant paths, grouped as one action on the undo stack.
- **Separate undo/redo stacks, action-based.** The engine and each copilot session own their own stacks. Each stack entry is an action — one reversible unit that may contain one or many ops. Undo inverts the whole action; redo re-applies it. New actions clear the redo stack.
- **Undo survives apply.** `apply()` is itself an action on the undo stack. Undoing it reverses the base change and restores ops to the active set.
- **Apply with no ops is a no-op.** No version bump, no stack entry.
- **Apply while copilot session is open throws.** `CopilotSessionOpenError`. The user must end the copilot session first.
- **Copilot auto-resolution on user edit.** When the user edits during an open copilot session, the engine automatically resolves overlapping copilot ops: same-path → auto-decline; descendant (user edits below copilot's path) → auto-accept copilot op into engine; ancestor (user edits above, replacing the subtree) → auto-decline copilot op (cascading to any copilot ops inside). Unrelated paths coexist.
- **Conflict flag only for the reverse direction.** `conflictsWithUser: true` flags a copilot op proposed at a path the user has already touched. In that direction, no automatic resolution fires — the user decides on approve.
- **Undo on empty stack is a no-op.** Matches standard editor behavior.
- **Export is a deep copy.** No reference leaks to the engine's internal state.
- **Arrays are keyed internally, indexed externally.** The public API accepts and returns plain JSON (arrays are arrays). Internally, every array element is assigned a stable key so ops can reference elements by identity rather than position. Index-based paths in incoming ops are translated to key-based references at propose-time. This is an implementation detail behind an adapter — callers work with JSON Patch-style paths and never see the keys. See §3.10.

---

## 7. Versioning plan

- **v0** — everything above: continuous editing model, nested copilot sessions, action-based undo/redo with undo-surviving apply, cascading revert, conflict indicator and auto-decline rules, insertion-order diffs + diffTree, keyed-array internal representation, version counter for reactivity, implicit parent creation on `add`, MCP toolkit, in-memory export. Schema validation stubbed. Op kinds limited to `add` / `remove` / `replace`.
- **v1** — schema validation layer (JSON Schema or Zod adapter) wired into the `validate` hook; ops rejected at propose-time if they would produce an invalid state. Also: first-class `move` op (likely trivial given keyed array representation — it's just a reorder).
- **v2** — server-side deployment: multi-user concurrency, conflict resolution, optimistic locking or CRDT-style merging, serialization/hydration. Batch propose with atomic semantics.
- **Later** — richer MCP toolkit surface (resources, not just tools). Event emitter in addition to version counter if reactive frameworks prove to want push rather than pull.

---

## 8. Resolved design decisions

The initial open questions have been resolved as follows — recorded here so the rationale isn't lost:

1. **Revert of an untouched path.** Throws `NoOpAtPathError`. Silent no-ops hide caller bugs.
2. **Op ordering in `diff()`.** Insertion order by default. `diffTree()` added as a separate method for subtree-grouped views. Framework provides both primitives; UI chooses.
3. **Copilot session lifecycle.** Stays open until explicit `end()` (or `approveAll` / `declineAll`). Per-op approve/decline does not close the session — the user can approve some, ask for more, review again.
4. **Array / move / copy ops.** Only `add`, `remove`, `replace` in v0. `move` and `copy` deferred to post-v2; they require tracking key identity across paths and complicate revert semantics.
5. **User edits during copilot session — "user is king."** Auto-decline on same path (override); **auto-accept** on descendant (user building on copilot's structure, implies acceptance); auto-decline on ancestor with cascade (user replacing the whole subtree). Unrelated paths coexist. The reverse direction (copilot proposes into user-touched territory) never auto-resolves — it flags `conflictsWithUser: true` and leaves the decision to the user on approve.
6. **Undo/redo stacks hold actions, not ops.** A cascading revert of 3 ops is one action; one `undo()` brings all 3 back.
7. **Cascading revert.** Reverting a path also reverts all descendant ops, grouped into one action.
8. **Continuous editing replaces user sessions.** The original design had a `UserSession` class with open/close lifecycle and `commit()`/`discard()`. This was replaced with continuous editing directly on the `Engine` because the session lifecycle didn't match the user's mental model — they expect one continuous editing experience, not a series of transactions. `apply()` replaces `commit()` with the key difference that undo history survives. See DESIGN.md §1.5 for the full rationale.
9. **Undo on empty stack.** No-op. Matches standard editor behavior.
10. **`actor` field is engine-set.** The caller provides `OpInput` (kind, path, value). The engine adds `actor`, `ts`, and `prev` based on context. This prevents callers from spoofing actor identity.
11. **`end()` drops unresolved ops.** Calling `end()` on a copilot session discards any remaining copilot ops that haven't been approved or declined.
