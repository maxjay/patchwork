# Design Record

*The reasoning, scenarios, and alternatives behind every decision in `SPEC.md`.*

This document is the design companion to `SPEC.md`. Where the spec tells you **what the library does**, this doc tells you **why it works that way** — including the scenarios we walked through, the alternatives we considered, and the pushback that reshaped the design.

Read this when:
- You're about to change a rule and want to know if the original reasoning still holds.
- You're onboarding and need to understand the principles, not just the API.
- You're writing tests and need concrete scenarios to ground them.

---

## 0. Foundational framing

### 0.1 The user story

> "I have a JSON document. I, as the user, am making edits over it, which I can view the differences of because the engine can give me the value of any key and also the differences that have happened. But I also talk to copilot and ask copilot to make some changes, which I can review and approve. I have to be able to see these copilot differences away from my own differences for the approval and decline. We should be able to undo changes at individual operation granularity — if I edit two values, I can undo them individually. This can be a button next to each value in the UI."

This is the origin of the design. Every rule in the spec traces back to a phrase in this story.

### 0.2 Principles

These principles drove the whole design. When in doubt, fall back to them.

**Framework, not UI.** We're building the engine that powers editing experiences. We're not building the editing UI itself. The engine gives callers primitives and data; the UI decides how to render them.

**User is king.** The human user is the primary actor. Their direct actions take precedence and the engine infers the right resolution automatically where possible. The copilot is a secondary actor whose work is always routed through user review.

**Copilot is a secondary actor.** Copilot operates through the same editing primitives as the user, but its output lives in a nested layer that the user explicitly approves or declines. Copilot never writes directly to the engine's op set.

**All state is observable and derivable.** Effective values, diffs, conflict flags — everything the UI needs to render — comes out of the engine via query methods. The engine never needs to push, because the UI can always pull what it needs.

**Ops are the unit of change.** Every edit is a discrete, addressable operation (add / remove / replace at a path). This makes diffs cheap, undo unambiguous, and copilot-authored edits easy to represent as data.

**Actions are the unit of reversibility.** One user gesture may produce multiple ops (e.g. cascading revert). Undo/redo operate on *actions* — the gesture-level grouping — not on raw ops.

### 0.3 The two-package split

**`<core-engine-package>`** — the editing model, ops, diffs, undo, export. Pure TypeScript, no runtime dependencies beyond what Node/browser provide.

**`<mcp-toolkit-package>`** — pre-built MCP tool definitions and handlers that bind to an engine instance. Not a server — a **toolkit** that developers use to expose their own engine over their own MCP server framework.

We split because bundling MCP into the core would force every consumer to take on an MCP dependency whether they wanted it or not. The core should be usable in a plain web app with no MCP anywhere.

### 0.4 Deployment model

The engine is designed to run **in-browser, local to a single user**. One human editing through one engine instance. Multiple tabs or tenants construct separate engine instances rather than sharing one.

This assumption justifies several simplifications:
- One engine instance per editing context (no need for session IDs in the public API).
- In-memory only (no persistence, no hydration).
- No locking, no concurrency control.
- Export returns a plain object; serialization is the host app's concern.

Server-side deployment (multi-user, concurrent edits, conflict resolution) is explicitly deferred to v2. It's a different problem — closer to CRDTs or OT — and trying to design for it now would over-engineer v0 and still get v2 wrong.

---

## 1. Why layered editing

### 1.1 The problem with direct mutation

The naive design is: give callers a JSON object, let them mutate it. This fails the moment you add copilot:

- No way to preview changes before applying.
- No way to separate user edits from copilot proposals.
- No way to undo at useful granularity.
- No way to audit what changed.

### 1.2 The draft layer model

Instead: all edits flow through the **engine** as ops on top of an immutable base. The effective state is base + pending ops, computed on read.

This gives us:
- Preview for free (read through the ops layer).
- Separation of actors (engine ops + nested copilot session = two layers).
- Clean undo (remove an op from the layer, layer recomputes).
- Audit trail (the op list is the audit log).

### 1.3 Why nest the copilot layer inside the engine layer

**Alternative considered.** A flat model where every op is tagged with an actor (`actor: 'user' | 'copilot'`). UI filters to render "my edits" vs "copilot's proposed edits."

**Why we rejected it.** Approval semantics get murky. If copilot and user both edited `/foo`, which wins when the user clicks "approve all"? What does "revert my edit" mean when copilot's edit shadows it? Flat actor tagging pushes these decisions out to every consumer.

**What we did instead.** Nested layers: base → engine ops → copilot ops. Copilot ops physically live in a separate layer on top. Approving a copilot op means folding it down into the engine layer; declining means dropping it. The layer structure *is* the review model. The UI gets a clean `engine.diff()` and `copilotSession.diff()` with no overlap to sort out.

### 1.4 One copilot session at a time

**Alternative considered.** Multiple concurrent copilot proposals as sibling layers.

**Why we rejected it.** Two reasons:
1. It's confusing for the user. If they ask copilot two things in parallel and get two proposal sets, the review UI has to disambiguate — and each proposal might touch overlapping paths with no defined precedence.
2. We don't have a use case that justifies it. Sequential copilot sessions (ask, review, approve, ask again) cover the workflow we care about.

**What we did instead.** Exactly one copilot session nested inside the engine at any time. Sequential copilot sessions are fine; concurrent ones are out of scope for v0.

### 1.5 Continuous editing replaces user sessions

**The original design.** The engine had a `UserSession` class with explicit open/close lifecycle. The user called `engine.startUserSession()` to begin editing and `session.commit()` / `session.discard()` to end. This mirrored a transactional model.

**Why we changed it.** The session lifecycle didn't match the user's mental model. They expect one continuous editing experience — type, undo, type more, apply when ready — not a series of transactions. The open/close ceremony added friction without adding value. The "commit" name was misleading too — it sounded like a Git commit (permanent, non-reversible), when the intent was more like "save" (fold changes, keep editing).

**What we did instead.** The editing methods (`propose`, `revert`, `undo`, `redo`, `diff`, `diffTree`) moved directly onto the `Engine`. No session to open or close — the engine is always ready for edits. `commit()` became `apply()`, which folds ops into the base and resets the diff, but crucially **preserves the undo stack**. The user can undo through an apply boundary, just like Cmd+S in a document editor doesn't erase your undo history.

The **copilot session** kept its session lifecycle because it genuinely is transactional — the copilot's proposals need explicit review before entering the user's edit history. The asymmetry is intentional: continuous for the user, transactional for copilot review.

---

## 2. Operations

### 2.1 Why JSON Patch–shaped ops

**Alternative considered.** Custom operation types, method calls like `engine.setField('/foo', 5)` with no uniform op representation.

**Why we rejected it.** Copilot output is the tell. LLMs are already good at emitting JSON Patch (RFC 6902) because it's a well-known spec. If we use a custom op shape, we either force the copilot to emit our custom shape (harder) or translate on the way in (brittle). JSON Patch is the common language.

**What we did instead.** Ops modeled on RFC 6902 with three extensions:
- `actor: 'user' | 'copilot'` — who authored this op.
- `ts: number` — when.
- `prev: unknown` — the value that was at this path before the op applied, captured at propose-time. This is what makes revert cheap — no recomputation, just drop in `prev`.

### 2.2 Why only add / remove / replace

**Alternative considered.** Include `move` and `copy` from RFC 6902. They map naturally to real user intent ("move this item to a different category").

**Why we deferred them.** They introduce **path identity**, which the current model doesn't have. If op #1 moves `/a` to `/b`, what does op #2 at `/b` mean — is it a modification of the thing that used to be at `/a`, or something new that happened to land at `/b`? Revert of a move has the same ambiguity. These questions are solvable but out of scope for v0. `move` and `copy` are deferred to post-v2, at which point we'll likely need to track key identity alongside paths.

**What we did instead.** `add`, `remove`, `replace` only. A UI-level "move" is two ops: `remove` at the old path, `add` at the new one. We lose the intent ("this is a move, not two unrelated edits") but gain simplicity.

### 2.3 The identity rule: one op per path

**Why it matters.** This is the quiet hero of the design. It makes revert unambiguous (there's always exactly one active op at a path to remove), makes diffs trivial to compute (scan the op list), and kills a class of bugs around op dependencies.

**The scenario it governs.** User proposes `replace /foo = 1`, then `replace /foo = 2`. In a naive model, both ops are in the layer and the second shadows the first. What does `revert('/foo')` do — remove both? Remove one? Which one?

**The answer.** One active op per path. When the second `replace /foo` comes in, it supersedes the first — the first is shadowed (not deleted from history, but no longer visible). `revert('/foo')` removes the current active op (the one with value 2), and the path returns to the value from the layer below. It does **not** "uncover" the shadowed op.

This matches user intuition from the original story: *"User can't revert op 2, because op 4 is on top. Does that make sense? The ID is the path."*

---

## 3. Undo, redo, and cascading revert

### 3.1 Two kinds of "undo"

Early in the design we conflated "undo" with "revert." They're related but distinct:

- **`undo()`** — reverses the most recent action. UI target: the global undo button. Order-dependent (pops from the stack).
- **`revert(path)`** — removes the active op at a specific path, regardless of when it was proposed. UI target: the X button next to a specific value in a diff view. Position-independent.

Both exist because they serve different UI affordances.

### 3.2 Redo semantics (standard editor behavior)

**Discussion.** The user asked: *"Undo moves things onto redo stack, if a change is made, undo stack clears right? Is that how it works normally?"*

**Answer and rule.** Yes — with a small correction. A new action clears the **redo** stack, not the undo stack. The undo stack accumulates everything; redo is only populated by undo calls and is wiped the moment the user does something new (because branching history abandons the previously-undone future).

Every editor you've used (VS Code, Word, Photoshop) works this way. We follow suit.

### 3.3 Separate stacks for engine and copilot

**Alternative considered.** One global undo/redo stack for everything.

**Why we rejected it.** Actor boundaries would leak. Undoing in the middle of a copilot session could silently reverse user edits, which breaks the mental model of the user being king of their own layer.

**What we did instead.** The engine and each copilot session own their own pair of stacks. Undoing in the copilot session touches only copilot ops; the user's history is separate.

### 3.4 Actions vs ops in the stack

**The scenario.** User does:
1. `engine.propose({ kind: 'add', path: '/a', value: {} })`
2. `engine.propose({ kind: 'add', path: '/a/b', value: 5 })`
3. `engine.revert('/a')` — cascades to remove `/a/b` too.
4. `engine.undo()`

What should undo do? If the stack holds raw ops, undo pops one and only one. We'd need three undos to restore both `/a` and `/a/b`, which is confusing — step 3 was a single user gesture.

**The rule.** The stack holds **actions**, not ops. An action is one reversible unit of work — possibly containing multiple ops. Step 3 produces a single action (a "revert group" containing both the `/a` and `/a/b` ops). One `undo()` restores the whole group.

**Worked trace:**

| Step | Action                  | Ops after step                   | Undo stack                                  | Redo stack |
|------|-------------------------|----------------------------------|---------------------------------------------|------------|
| 1    | `propose add /a = {}`   | `/a`                             | `[A1: add /a]`                              | `[]`       |
| 2    | `propose add /a/b = 5`  | `/a`, `/a/b`                     | `[A1, A2: add /a/b]`                        | `[]`       |
| 3    | `revert('/a')`          | (none)                           | `[A1, A2, A3: revert {/a, /a/b}]`           | `[]`       |
| 4    | `undo()`                | `/a`, `/a/b`                     | `[A1, A2]`                                  | `[A3]`     |
| 5    | `undo()`                | `/a`                             | `[A1]`                                      | `[A3, A2]` |
| 6    | `undo()`                | (none)                           | `[]`                                        | `[A3, A2, A1]` |
| 7    | `redo()`                | `/a`                             | `[A1]`                                      | `[A3, A2]` |

### 3.5 Cascading revert (the containment rule)

**Discussion.** The user asked: *"Would this just be considered like an add, but if the parent paths got removed, then that should be removed too, so I add a, and then I add a.b, and if I revert a, I reverted a.b too."*

**The principle.** Reverting a parent path reverts every descendant op, because the child ops have no meaningful existence without their parent. If you undo "create the folder," the files inside go too.

**The rule.** `engine.revert(path)` removes:
1. The active op at `path`.
2. Every active op at a descendant path.

All removed ops are grouped as one action on the undo stack, so `undo()` brings them all back together.

**What cascade does NOT apply to:**
- `undo()` — it pops the top action as-is. Whether that action contains one op or many depends on what originally produced it; undo doesn't inspect path relationships.
- Reverting a child — `revert('/a/b')` only removes `/a/b`. Children can be reverted in isolation; parents can't be reverted while leaving dangling children.

---

## 4. Arrays — the keyed-internal, indexed-external model

### 4.1 Why JSON Patch's array semantics fail us

RFC 6902 treats array indices as op identifiers. Remove at `/items/1` means "remove the thing at position 1." But positional indices aren't stable identifiers — they shift whenever any other op touches the array.

**The breakage.** Base is `[1, 2, 3]`. The engine has two ops:

- Op A: `remove /items/1` — removes the `2`, array is now `[1, 3]`.
- Op B: `replace /items/1 = 99` — targets what *is* at position 1 now, which is the `3`.

What does Op B's path actually mean? At propose-time it meant "the 3." After the array is exported, `/items/1` is now `99`. If the user reverts Op A, we try to re-insert `2` at position 1, producing `[1, 2, 99]` — the `3` is gone, replaced by an op that was supposed to target it.

**Paths aren't identifiers for array elements. Indices are ordering metadata, not identity.** Conflating them is the whole problem.

### 4.2 The fix: treat arrays as ordered objects internally

Every array element gets a stable key assigned by the engine. Internally, an array is an ordered collection of `(key, value)` pairs. Ops reference keys. The array's order is tracked separately from its elements' identity.

Base `[1, 2, 3]` is internally something like:

```
{ k1: { value: 1, order: 0 },
  k2: { value: 2, order: 1 },
  k3: { value: 3, order: 2 } }
```

Now:
- `remove /items/1` at propose-time resolves to "the key at order-position 1," which is `k2`. The op is stored internally as targeting `k2`, not position 1.
- `replace /items/1 = 99` at propose-time resolves to `k3` (the key at position 1 *after* `k2` was removed). The op is stored against `k3`.
- Reverting Op A restores `k2` at order 1. The array becomes `[1, 2, 99]` — wait, same problematic outcome as before. Let me reconsider.

**Actually, what this really fixes** isn't the interaction between ops; it's **op stability under unrelated changes**. In a positional model, Op B's path `/items/1` would silently target different things depending on what other ops did. In the keyed model, Op B is bound to `k3` from the moment it was proposed, forever. Revert of Op B always restores `k3`'s previous value, regardless of what else is happening in the array.

The revert-of-the-remove case (Op A) producing `[1, 2, 99]` is actually correct behavior: the user reverted only the remove, not the replace. If they want to revert both, they revert both. Each op stays bound to the element it was originally targeting.

### 4.3 JSON Patch is still our wire format

This is an important framing: **we don't depart from JSON Patch. We adapt to it at the boundary.**

- **Public API in.** Callers emit standard RFC 6902 JSON Patch-shaped ops with index-based paths. The engine translates index → key at propose-time and stores the op internally against the key.
- **Public API out.** `engine.get()` and `engine.export()` return plain JSON. Arrays are arrays, in order. Keys are stripped at the boundary.
- **Copilot.** Emits standard JSON Patch. Consumes the export (plain JSON) when it reads state. Never sees keys.
- **MCP toolkit.** Tool definitions speak JSON Patch. Responses are plain JSON. Keys stay inside.

Keyed identity is an internal implementation concern with adapters at both boundaries. No consumer — human, LLM, or tool — needs to know about keys.

### 4.4 What this buys us

- **Op stability.** Once bound to a key, an op's target never shifts under unrelated array mutations.
- **Trivial reorder support.** Reordering an array is changing the `order` field of a key. No path rewriting, no cascade of dependent ops.
- **`move` becomes trivial.** Moving an element to a new position is one op against its key, not a remove + add pair. This is why `move` is likely a cheap addition in v1 — the infrastructure is already there from v0.
- **Clean cascading revert on array descendants.** Ops at `/items/2/name` resolve to `(key-at-position-2, /name)` internally, so the cascade rule still works — "descendants of this element" is a well-defined set when the element has a stable key.

### 4.5 What this costs

- **Base parsing.** On engine construction, walk the base and assign keys to every array element. One pass, linear time.
- **Key management.** Insert assigns a new key; remove frees one. No complexity.
- **Op translation at the boundary.** Cheap — a path resolution on propose and on export.

Net: substantial correctness win for modest implementation complexity. The only genuine cost is that `value` comparisons across sessions need to go through the export path, not the internal representation — but that was already true.

### 4.6 Why this isn't "yet another custom format"

The objection would be: "Now you have a proprietary internal format instead of plain JSON." The counter: the format is **only** internal. Every input and every output is plain JSON. The keyed form never leaves the engine. It's equivalent to how a database might index rows internally without changing the SQL surface — implementation detail, not a format change for consumers.

---

---

## 5. Diffs and the review model

### 5.1 Each layer diffs against the layer below

- `engine.diff()` → the user's pending ops vs. base.
- `copilotSession.diff()` → copilot's ops vs. the current engine state (base + user ops).

This falls out of the layered model for free. It also means the two diffs are naturally disjoint: the user's review pane shows copilot's proposed changes, and the user's draft view shows their own edits — no filtering or cross-referencing needed.

### 5.2 Why insertion order for `diff()`

**Alternative A considered: path-sorted.** Predictable order, good for stable UIs.

**Alternative B considered: subtree-grouped.** Mirrors Git's file-grouped diff view, which is easy to scan when edits span many subtrees.

**The scenario that made us think twice.** User edits `/database/host`, `/cache/ttl`, `/database/port`, `/logging/level`. In insertion order that's a jumbled review pane:

```
/database/host: "localhost" → "prod.db"
/cache/ttl: 60 → 300
/database/port: 5432 → 5433
/logging/level: "info" → "debug"
```

Subtree-grouped is much easier to review:

```
database/
  host: ...
  port: ...
cache/
  ttl: ...
logging/
  level: ...
```

**And the parent-child scenario.** User sets `/server = { host: "x", port: 80 }`, then later edits `/server/port = 8080`. Two active ops, one is a parent of the other. Insertion order doesn't convey the relationship; subtree-grouped does.

**The resolution.** *"Insertion order is the easiest. If people want to get trees we can add a method for that. We are a framework."*

This is the framework principle paying off. We provide both primitives:
- `diff()` — insertion order. Matches undo ordering. What you want for timeline-style UIs.
- `diffTree()` — same ops, tree-structured by path. What you want for subtree-grouped review UIs.

The framework gives both; the UI chooses.

### 5.3 The conflict indicator

**The scenario that motivated it.** User edits `/timeout = 30`. User asks copilot "tune for production." Copilot proposes `/timeout = 60`. User glances at the review pane and clicks approve without realizing it clobbers their own edit. They wanted both 30 and copilot's insight — they got 60 and lost their edit silently.

Last-write-wins is technically defensible but surprising. The user deserves a warning.

**The rule.** In `copilotSession.diff()`, each entry may carry `conflictsWithUser: true` when the user has already edited an overlapping path (equal or related by ancestry/descent) *before* the copilot proposed. The flag is advisory: approval still proceeds last-write-wins, but the UI should render a warning indicator (e.g. yellow highlight, "this will overwrite your edit") so the user doesn't clobber by reflex.

**Why only copilot diffs carry the flag.** The engine diffs against the base. The base can't "conflict" with the user — the user is the primary actor making first-order changes to the base. There's no second actor in the engine layer to conflict with.

**Why the reverse direction doesn't need the flag.** When the user edits a path *after* copilot proposed into it, the engine automatically resolves (see §5). No flag needed — the resolution already happened.

---

## 6. User edits during an open copilot session — the "user is king" rules

This is the trickiest area of the design. It earned its own section because the scenarios are subtle and we iterated on them several times.

### 6.1 The setup

A copilot session is open with pending proposals. The user continues editing directly through `engine.propose()` — in parallel to reviewing copilot's work. What happens when the user's edit touches a path that overlaps with a copilot proposal?

### 6.2 The four cases

We identified four path-relationship cases between a new user edit and existing copilot ops:

| User edits...                              | Example                                                           |
|--------------------------------------------|-------------------------------------------------------------------|
| The **same path** as a copilot op          | Copilot: `/timeout = 60`. User: `/timeout = 45`.                  |
| A **descendant** of a copilot op           | Copilot: `/server = { host: "x" }`. User: `/server/port = 8080`.  |
| An **ancestor** of a copilot op            | Copilot: `/server/port = 8080`. User: `/server = { host: "x" }`.  |
| An **unrelated** path                      | Copilot: `/db/host = ...`. User: `/cache/ttl = ...`.              |

Each case required its own analysis.

### 6.3 Case A: same path → auto-decline

**Scenario.** Copilot proposes `/timeout = 60`. User types `/timeout = 45` directly into the UI.

**Reasoning.** The user's intent is unambiguous: they saw copilot's suggestion, disagreed, and substituted their own value. Keeping copilot's op pending would be confusing — if the user later clicks "approve all," copilot's 60 would clobber their 45.

**The rule.** Auto-decline. Copilot's op is removed from the copilot layer. The user's op stands alone.

**What about `conflictsWithUser`?** Not needed — the copilot op no longer exists, so there's nothing to flag.

### 6.4 Case B: descendant → auto-accept (the non-obvious one)

**Scenario.** Copilot proposes `/server = { host: "x" }`. User then adds `/server/port = 8080`.

**Initial hypothesis (rejected).** "This is just overlapping territory — flag it as a conflict."

**The insight (from the user).** *"If the copilot first creates server, and the user then creates server/port, this means they've accepted the server addition by copilot. They can revert all of the server, as it's been a change against the original."*

The user literally couldn't edit `/server/port` unless `/server` existed. By editing a descendant, they're building on copilot's structure — which is implicit acceptance of the parent.

**The rule.** Auto-accept the copilot op. The `/server` op is folded into the engine's op set. The user's `/server/port` op lands next. Both are now in the engine as separate actions on the undo stack, so:
- Undo once → removes `/server/port`.
- Undo twice → removes `/server` (the auto-accepted copilot op).
- Revert `/server` → cascades and removes both, as one action.

**Why the auto-accept is a separate stack entry from the user's edit.** So the user can undo their own edit without also reverting the auto-accept. Each remains independently reversible.

### 6.5 Case C: ancestor → auto-decline with cascade

**Scenario.** Copilot proposes `/server/port = 8080`. User edits `/server = { host: "x" }` — replacing the whole server object.

**Options considered.**
- *Auto-accept (analogous to Case B).* The user is touching the subtree; fold copilot's op in. **Rejected** — the user's replacement might deliberately not include port, and auto-applying copilot's port over it would be surprising and wrong.
- *Conflict flag, no automatic decision.* Let the user decide. **Rejected** — leaves a stale copilot op lingering in a subtree that's been wholesale replaced.
- *Auto-decline.* The user declared what `/server` is by replacing it; anything narrower that came before is superseded. **Accepted.**

**The decision.** *"User is king. Copilot is auto-declined."*

**The rule.** Auto-decline. Copilot's op at `/server/port` is removed from the copilot layer. The cascade applies: any other copilot ops inside the `/server` subtree are also auto-declined.

### 6.6 Case D: unrelated → coexist

**Scenario.** Copilot proposes `/db/host = "prod"`. User edits `/cache/ttl = 300`.

**The rule.** No relationship, no action. The copilot op stays pending, the user's op stays in the user layer, and both are reviewed/applied independently. No conflict flag, no auto-resolution.

### 6.7 Summary table

| Relation (copilot op vs. user's new edit) | Action on copilot op              |
|-------------------------------------------|-----------------------------------|
| Same path                                 | Auto-decline                      |
| User edits a descendant                   | Auto-accept (fold into user layer)|
| User edits an ancestor                    | Auto-decline (cascade to subtree) |
| Unrelated                                 | Coexist                           |

### 6.8 Reverse direction: copilot proposes into user-touched territory

**The distinction.** §5.3–5.6 govern the case where the user edits *after* the copilot has already proposed. When the order is reversed — user edited first, copilot proposes second — the engine does **not** automatically resolve.

**Why the asymmetry.** User is king. The engine reads user actions as authoritative and reacts to them (auto-accept, auto-decline). Copilot actions are always subject to review. If copilot proposes into territory the user has already touched, that's exactly what the review pane is for. The engine surfaces `conflictsWithUser: true` on the diff entry and lets the user decide.

---

## 7. Specific design decisions

Short entries — each captures a decision, the alternatives, and the reasoning.

### 7.1 Revert of an untouched path throws

**Alternatives.** Silent no-op; throw.

**Decision.** Throw `NoOpAtPathError`. Silent no-ops hide caller bugs (stale UI state, typos, wrong path). Callers who want the "revert if present" semantics can catch and ignore — but the default should surface bugs, not hide them.

### 7.2 No session IDs needed

**Alternatives.** Expose session IDs publicly; keep internal.

**Decision.** Not needed in v0. With continuous editing on the engine and at most one copilot session at a time, there's nothing to disambiguate. IDs may become necessary in v2 when server-side multi-user lands.

### 7.3 Copilot session lifecycle

**The question.** When some copilot ops are approved mid-session, does the session close or stay open?

**Decision.** Stays open until explicit `end()`, `approveAll()`, or `declineAll()`. Per-op approve/decline does not close the session.

**Why.** This matches the natural workflow: user asks copilot, sees five suggestions, approves three, asks copilot for more changes, reviews again. Closing on first approve would fragment that flow into many tiny copilot sessions.

### 7.4 Schema validation is v1, not v0

**Decision.** The `validate?: (next: T) => void` hook exists from v0. It's unused (no-op) in v0. v1 wires in JSON Schema or Zod.

**Why it's v0→v1's defining feature.** *"Schema is optional but definitely huge. Assume for now. We won't validate, but we definitely will need to, and that's how we know we have v1."*

Schema validation is the single largest feature gap between prototype and production. Naming it as the v1 gate gives us a clear cut-point.

**Why the hook exists from v0.** So the API shape survives contact with validation. A hook that doesn't exist yet can be designed wrong; a hook that's called but doesn't do anything is known to work.

### 7.5 Export returns a deep copy

**Decision.** `engine.export()` returns a deep copy of the current effective config, not a reference to internal state.

**Why.** No reference leaks. Callers can mutate what they get back without corrupting the engine. Also makes serialization trivial — `JSON.stringify(engine.export())` is safe.

### 7.6 "Copilot" as the name, not "ProposalSession"

**Alternative considered.** `ProposalSession` — actor-neutral naming that would generalize if a second non-user actor showed up later.

**Decision.** Keep "copilot."

**Why.** The domain is copilot-assisted editing. Over-abstracting the name now ("there might be a linter actor too someday") makes the API harder to read for the common case without providing real value. If a second non-user actor materializes, that's a real design change requiring its own analysis, not something we should paper over with generic naming today.

### 7.7 One engine per editing context

**Alternative considered.** Engine holds a map of named editing contexts or sessions.

**Decision.** One engine instance per editing context. Multiple tabs or tenants construct separate engine instances.

**Why.** The deployment model is browser-local: one engine instance per UI context (tab, tenant, whatever the host app considers a scope). Multi-user within one engine would be the right abstraction for server-side. We don't have that use case in v0 and shouldn't design for it.

### 7.8 No built-in MCP server

**Alternative considered.** Ship a runnable MCP server out of the box.

**Decision.** Ship a toolkit — pre-built tool definitions and handlers — that developers wire into their own MCP server framework.

**Why.** MCP server frameworks evolve fast (official SDK, fastmcp, custom). Locking ourselves to one makes the library less useful. The toolkit is framework-neutral and lets the developer own the server lifecycle, auth, transport, etc.

---

## 8. What got considered and cut

Not every idea survived the design discussion. Noting the cuts so they aren't relitigated.

### 8.1 Global undo stack

Rejected in favor of separate stacks for engine and copilot. Actor boundaries would leak — undoing during copilot review could reverse user work, which contradicts "user is king."

### 8.2 Flat actor tagging (no nested copilot layer)

Rejected. Approval semantics get murky when user and copilot edits are intermingled in one layer. The nested layer model makes review clean.

### 8.3 Concurrent copilot proposals

Rejected for v0. Confusing for the user, no clear precedence rules, no driving use case.

### 8.4 Explicit user session lifecycle

Rejected. The original `UserSession` class with `startUserSession()` / `commit()` / `discard()` was replaced by continuous editing directly on the `Engine` with `apply()`. See §1.5 for the full rationale.

### 8.5 Redo as a post-v0 feature

Originally deferred. Reversed the call — redo is ~20 extra lines, the data for it is already in the op log, and the moment anyone builds a UI with an undo button they'll ask for redo. Pulled into v0.

### 8.6 `move` and `copy` ops

Deferred to post-v2. Introduce path-identity complexity that the v0 model isn't equipped for. UI-level moves are two ops in v0 (remove + add).

### 8.7 Persistence

Deferred. v0 is in-memory with export-on-demand. Serialization format and hydration rules are a real design problem and were not worth solving before the core model is stable.

---

## 9. Resolved questions and remaining open items

### 9.1 Resolved (decisions recorded)

**Reactivity model.** UI calls into the engine; engine updates state; UI reads updated state. The engine exposes `engine.version` — a monotonic counter that increments on every state change. React, Vue, Svelte, etc. subscribe to this number through their normal reactivity primitives and re-read when it changes. No event emitter, no onChange callback — the pull model stays intact, augmented with a version token the UI can watch. Minimal API surface, framework-agnostic, fits naturally with the reactive patterns consumers already use.

**Actor field on folded ops.** When a copilot op is approved or auto-accepted, the `actor: 'copilot'` is preserved. No rewrite, no third status. Auditability is retained for free — "who originally proposed this" is always recoverable.

**Implicit parent creation on `add`.** If copilot or user proposes `add /a/b/c = 3` and the parent path doesn't exist, the engine creates the parents as needed. The inferred types follow JSON Pointer conventions: numeric segments create arrays, non-numeric segments create objects. The creation is part of the same op — one user intent produces one op, and revert removes everything the op created. `remove` on a missing path still throws — removal is explicit destruction and a missing target is a real error.

**Array operation semantics.** Splice, per RFC 6902. `remove /items/1` from `[1, 2, 3]` produces `[1, 3]`. Internally, arrays use the keyed representation from §4 so ops remain bound to element identity across mutations. Add at `/items/-` appends.

**Batch propose.** Out of scope for v0. Callers propose one op at a time. If a batch API becomes necessary, it can be added as `proposeBatch(ops)` in a later version without breaking the single-op API. Atomicity semantics (all-or-nothing vs per-op) can be decided then.

**Undo on empty stack.** No-op. Matches standard editor behavior (VS Code, Word, etc.). No throw — silently doing nothing on empty undo/redo is a UI expectation.

**Continuous editing replaces user sessions.** The `UserSession` class with explicit open/close lifecycle was replaced by editing methods directly on `Engine`. `commit()` / `discard()` were replaced by `apply()`, which folds ops into the base while preserving the undo stack. See §1.5 for the full rationale.

### 9.2 Still open

**Error model completeness.** `NoOpAtPathError`, `PathNotFoundError`, `InvalidPathError`, `CopilotSessionOpenError` (on apply) are implemented. A complete taxonomy should be enumerated before the API stabilizes.

**Copilot op targeting after auto-accept.** When a user edit auto-accepts a copilot op at `/server`, and then copilot (still in the same session) proposes another op touching `/server/something`, does the engine treat that as "copilot is editing the engine's layer" (already accepted the context) or "copilot is proposing a new change under the newly-folded parent"? Likely the latter, but worth confirming with a scenario.

**Version counter overflow / reset.** Does the counter reset on `apply()`? Stay monotonic forever? What happens at `Number.MAX_SAFE_INTEGER`? (Unlikely in practice, but worth noting.)
