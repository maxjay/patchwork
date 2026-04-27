# Scenarios

*State-machine-style analysis of engine behavior. Each scenario is a concrete, test-shaped case covering one rule or interaction.*

This document complements `SPEC.md` (the rules) and `DESIGN.md` (the reasoning). Its job is to enumerate the **observable behaviors** of the engine as state transitions, so:

1. The design is pressure-tested against concrete cases before implementation.
2. Tests can be generated directly from scenarios (each scenario = one test).
3. Future changes to rules have a regression surface to check against.

---

## 0. Model

### 0.1 State variables

At any moment, the engine state is fully described by:

```
E = engine's internal state:
  base          : JSON object           (immutable after construction)
  userSession   : UserSession | null
  
UserSession = {
  ops           : Op[]                   (in insertion order)
  undo          : Action[]
  redo          : Action[]
  copilotSession: CopilotSession | null
}

CopilotSession = {
  ops           : Op[]                   (in insertion order)
  undo          : Action[]
  redo          : Action[]
}

Op = { path, kind, value?, prev?, actor, ts }

Action = {
  kind  : 'propose' | 'revert' | 'auto-accept'
  ops   : Op[]                           (ops that make up this action)
}
```

### 0.2 Inputs (state transitions)

Every caller-visible operation is a transition. Grouped by the session it acts on:

**Engine-level**
- `engine.get(path)` — read only, no state change
- `engine.startUserSession()`
- `engine.export()` — read only
- `engine.activeUserSession()` — read only

**UserSession**
- `us.propose(op | op[])`
- `us.revert(path)`
- `us.undo()`
- `us.redo()`
- `us.diff()` / `us.diffTree()` — read only
- `us.startCopilot()`
- `us.activeCopilotSession()` — read only
- `us.commit()`
- `us.discard()`

**CopilotSession**
- `cs.propose(op | op[])`
- `cs.revert(path)`
- `cs.undo()`
- `cs.redo()`
- `cs.approve(path)`
- `cs.decline(path)`
- `cs.approveAll()`
- `cs.declineAll()`
- `cs.end()`

### 0.3 Observable outputs

After each transition, assertions can be made over:

- `engine.get(path)` for any path
- `us.diff()` and `us.diffTree()`
- `cs.diff()` and `cs.diffTree()` (including `conflictsWithUser` flags)
- `us.undo` / `us.redo` stack contents (for white-box tests)
- `cs.undo` / `cs.redo` stack contents
- Thrown errors

### 0.4 Scenario format

Each scenario below follows this structure:

```
SCENARIO NAME
  Initial state:    (starting engine state)
  Action:           (single transition or sequence)
  Expected state:   (resulting state)
  Expected reads:   (what observable methods should return)
  Notes:            (optional commentary)
```

Scenario IDs are `<AREA>-<NUMBER>` (e.g. `UNDO-03`) so tests can reference them.

---

## 1. Basic session mechanics (BASIC)

### BASIC-01 — Engine starts with no sessions

```
Initial state:
  engine = new Engine({ a: 1 })
Action:
  (none)
Expected reads:
  engine.get('/a') === 1
  engine.activeUserSession() === null
  engine.export() === { a: 1 }   // deep copy, not reference
```

### BASIC-02 — Starting a user session

```
Initial state:
  engine = new Engine({ a: 1 })
Action:
  us = engine.startUserSession()
Expected state:
  engine.activeUserSession() === us
  us.ops = []
  us.undo = []
  us.redo = []
Expected reads:
  us.diff() === []
```

### BASIC-03 — Can't start two user sessions

```
Initial state:
  engine = new Engine({ a: 1 })
  us1 = engine.startUserSession()
Action:
  engine.startUserSession()
Expected:
  throws SessionAlreadyOpenError
```

### BASIC-04 — Propose a single op

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
Action:
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Expected state:
  us.ops.length === 1
  us.undo.length === 1
  us.redo === []
Expected reads:
  engine.get('/a') === 2
  us.diff() === [{ path: '/a', kind: 'replace', value: 2, prev: 1, actor: 'user', ts: ... }]
```

### BASIC-05 — Commit folds ops into base

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.commit()
Expected state:
  engine.activeUserSession() === null
Expected reads:
  engine.get('/a') === 2
  engine.export() === { a: 2 }
```

### BASIC-06 — Discard throws ops away

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.discard()
Expected state:
  engine.activeUserSession() === null
Expected reads:
  engine.get('/a') === 1
  engine.export() === { a: 1 }
```

### BASIC-07 — Base is not mutated by propose

```
Initial state:
  base = { a: 1 }
  engine = new Engine(base)
  us = engine.startUserSession()
Action:
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Expected:
  base.a === 1   // caller's original object untouched
```

### BASIC-08 — Export returns deep copy

```
Initial state:
  engine = new Engine({ nested: { a: 1 } })
Action:
  exported = engine.export()
  exported.nested.a = 999
Expected:
  engine.get('/nested/a') === 1   // engine state unaffected
```

---

## 2. The identity rule (IDENTITY)

### IDENTITY-01 — Second propose at same path supersedes first

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.propose({ kind: 'replace', path: '/a', value: 3 })
Expected state:
  us.ops (active) has one entry at /a with value 3
  us.undo.length === 2   // both are separate actions
Expected reads:
  engine.get('/a') === 3
  us.diff().length === 1   // only the active op
```

### IDENTITY-02 — Revert after shadowing removes latest, not shadowed

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  us.propose({ kind: 'replace', path: '/a', value: 3 })
Action:
  us.revert('/a')
Expected reads:
  engine.get('/a') === 1   // back to base, NOT value 2
  us.diff() === []
```

### IDENTITY-03 — Undo after shadowing restores previous active op

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  us.propose({ kind: 'replace', path: '/a', value: 3 })
Action:
  us.undo()
Expected reads:
  engine.get('/a') === 2   // shadowed op becomes active again
  us.diff().length === 1
  us.diff()[0].value === 2
Notes:
  Undo is not identical to revert. Undo pops the most recent action;
  revert removes the currently-active op at a path. When a path has
  shadowed history, undo can uncover earlier ops, but revert cannot.
```

---

## 3. Undo and redo (UNDO)

### UNDO-01 — Undo single propose

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.undo()
Expected state:
  us.ops = []
  us.undo = []
  us.redo.length === 1
Expected reads:
  engine.get('/a') === 1
  us.diff() === []
```

### UNDO-02 — Redo replays undone action

```
Initial state:
  (as UNDO-01 after undo)
Action:
  us.redo()
Expected state:
  us.ops.length === 1
  us.undo.length === 1
  us.redo = []
Expected reads:
  engine.get('/a') === 2
```

### UNDO-03 — New action clears redo stack

```
Initial state:
  engine = new Engine({ a: 1, b: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  us.undo()   // redo stack now has one entry
Action:
  us.propose({ kind: 'replace', path: '/b', value: 2 })
Expected state:
  us.redo = []   // cleared
  us.undo.length === 1
Expected reads:
  engine.get('/a') === 1
  engine.get('/b') === 2
```

### UNDO-04 — Undo is a no-op when stack is empty

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
Action:
  us.undo()
Expected:
  no state change; no throw
  (or throws, depending on final decision — see DESIGN §8.3)
```

### UNDO-05 — Per-session stacks are isolated

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 10 })
Action:
  cs.undo()
Expected state:
  cs.ops = []
  us.ops.length === 1   // user ops untouched
Expected reads:
  engine.get('/a') === 2   // user layer value, copilot layer empty
```

---

## 4. Cascading revert (CASCADE)

### CASCADE-01 — Revert parent removes children (worked example)

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  us.propose({ kind: 'add', path: '/a', value: {} })
  us.propose({ kind: 'add', path: '/a/b', value: 5 })
Action:
  us.revert('/a')
Expected state:
  us.ops = []
  us.undo.length === 3   // A1 add /a, A2 add /a/b, A3 revert group {/a, /a/b}
  us.redo = []
Expected reads:
  engine.get('/a') === undefined
  us.diff() === []
```

### CASCADE-02 — Undo after cascade restores both ops together

```
Initial state:
  (as CASCADE-01 after revert)
Action:
  us.undo()
Expected state:
  us.ops.length === 2   // both /a and /a/b back
  us.undo.length === 2
  us.redo.length === 1
Expected reads:
  engine.get('/a') === { b: 5 }
  engine.get('/a/b') === 5
```

### CASCADE-03 — Redo replays cascade as one action

```
Initial state:
  (as CASCADE-02 after undo)
Action:
  us.redo()
Expected state:
  us.ops = []
  us.undo.length === 3
  us.redo = []
Expected reads:
  engine.get('/a') === undefined
```

### CASCADE-04 — Revert child does not affect parent

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  us.propose({ kind: 'add', path: '/a', value: {} })
  us.propose({ kind: 'add', path: '/a/b', value: 5 })
Action:
  us.revert('/a/b')
Expected state:
  us.ops.length === 1   // /a remains, /a/b gone
Expected reads:
  engine.get('/a') === {}
  engine.get('/a/b') === undefined
```

### CASCADE-05 — Revert of untouched path throws

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
Action:
  us.revert('/a')
Expected:
  throws NoOpAtPathError
Notes:
  /a has a value in base but no op in this session.
  Revert is session-scoped; it operates on session ops, not base.
```

### CASCADE-06 — Deep cascade (multi-level descendants)

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  us.propose({ kind: 'add', path: '/a', value: {} })
  us.propose({ kind: 'add', path: '/a/b', value: {} })
  us.propose({ kind: 'add', path: '/a/b/c', value: 5 })
  us.propose({ kind: 'add', path: '/a/b/d', value: 6 })
  us.propose({ kind: 'add', path: '/a/e', value: 7 })
Action:
  us.revert('/a')
Expected state:
  All five ops removed in one action.
  us.undo.length === 6   (5 proposes + 1 revert group)
Expected reads:
  engine.get('/a') === undefined
  us.diff() === []
```

### CASCADE-07 — Revert of mid-level subtree

```
Initial state:
  (as CASCADE-06 before revert)
Action:
  us.revert('/a/b')
Expected state:
  /a and /a/e remain; /a/b, /a/b/c, /a/b/d removed as one action
Expected reads:
  engine.get('/a') === { e: 7 }
  engine.get('/a/b') === undefined
```

---

## 5. Copilot propose, approve, decline (COPILOT)

### COPILOT-01 — Copilot session nests inside user session

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
Action:
  cs = us.startCopilot()
Expected state:
  us.copilotSession === cs
  cs.ops = []
Expected reads:
  us.activeCopilotSession() === cs
```

### COPILOT-02 — Cannot start copilot without user session

```
Initial state:
  engine = new Engine({ a: 1 })
Action:
  engine.activeUserSession()?.startCopilot()
Expected:
  N/A — there is no user session to call .startCopilot() on.
  Calling .startCopilot() on a null user session is a TypeScript-level
  impossibility; enforced by the type system.
```

### COPILOT-03 — Only one copilot session at a time

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  cs1 = us.startCopilot()
Action:
  us.startCopilot()
Expected:
  throws CopilotAlreadyOpenError
```

### COPILOT-04 — Approve folds copilot op into user layer

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  cs.approve('/a')
Expected state:
  cs.ops = []
  us.ops.length === 1   // approved op now in user layer
  us.undo.length === 1
Expected reads:
  engine.get('/a') === 2
  cs.diff() === []
  us.diff()[0].path === '/a'
```

### COPILOT-05 — Decline drops copilot op without folding

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  cs.decline('/a')
Expected state:
  cs.ops = []
  us.ops = []
Expected reads:
  engine.get('/a') === 1
  cs.diff() === []
```

### COPILOT-06 — Copilot session stays open after per-op approve

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'add', path: '/a', value: 1 })
  cs.propose({ kind: 'add', path: '/b', value: 2 })
Action:
  cs.approve('/a')
Expected state:
  us.copilotSession === cs   // still open
  cs.ops.length === 1        // /b still pending
Expected reads:
  us.activeCopilotSession() === cs
```

### COPILOT-07 — approveAll folds all ops and ends session

```
Initial state:
  (as COPILOT-06 before approve)
Action:
  cs.approveAll()
Expected state:
  us.copilotSession === null   // session ended
  us.ops.length === 2
Expected reads:
  engine.get('/a') === 1
  engine.get('/b') === 2
```

### COPILOT-08 — declineAll drops all ops and ends session

```
Initial state:
  (as COPILOT-06 before approve)
Action:
  cs.declineAll()
Expected state:
  us.copilotSession === null
  us.ops = []
Expected reads:
  engine.get('/a') === undefined
  engine.get('/b') === undefined
```

### COPILOT-09 — end() closes session with remaining ops declined

```
Initial state:
  (as COPILOT-06 before approve)
Action:
  cs.end()
Expected state:
  us.copilotSession === null
  us.ops = []   // unresolved copilot ops are effectively dropped
```

### COPILOT-10 — Sequential copilot sessions after end

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs1 = us.startCopilot()
  cs1.propose({ kind: 'add', path: '/a', value: 1 })
  cs1.approveAll()
Action:
  cs2 = us.startCopilot()
Expected state:
  cs2 is a new, empty session
  cs1 is finalized (closed)
Expected reads:
  cs2.diff() === []
  us.ops.length === 1   // /a is still there from cs1's approve
```

---

## 6. The "user is king" matrix (KING)

The core matrix from DESIGN §5. Each scenario tests one cell.

### KING-01 — Same path: user edit auto-declines copilot op

```
Initial state:
  engine = new Engine({ timeout: 30 })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/timeout', value: 60 })
Action:
  us.propose({ kind: 'replace', path: '/timeout', value: 45 })
Expected state:
  cs.ops = []   // auto-declined
  us.ops.length === 1
Expected reads:
  engine.get('/timeout') === 45
  cs.diff() === []
  us.diff()[0].value === 45
```

### KING-02 — Descendant: user edit auto-accepts copilot parent op

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } })
Action:
  us.propose({ kind: 'add', path: '/server/port', value: 8080 })
Expected state:
  cs.ops = []   // folded down
  us.ops.length === 2   // the folded /server + new /server/port
  us.undo.length === 2   // separate actions: auto-accept, then user propose
Expected reads:
  engine.get('/server') === { host: 'x', port: 8080 }
  us.diff().length === 2
  cs.diff() === []
```

### KING-03 — Descendant auto-accept: undo reverses user edit only

```
Initial state:
  (as KING-02 after action)
Action:
  us.undo()
Expected state:
  us.ops.length === 1   // /server remains (auto-accepted), /server/port gone
Expected reads:
  engine.get('/server') === { host: 'x' }
```

### KING-04 — Descendant auto-accept: second undo reverses the auto-accept

```
Initial state:
  (as KING-03 after undo)
Action:
  us.undo()
Expected state:
  us.ops = []
Expected reads:
  engine.get('/server') === undefined
```

### KING-05 — Descendant auto-accept: revert parent cascades to child

```
Initial state:
  (as KING-02 after action)
Action:
  us.revert('/server')
Expected state:
  us.ops = []   // both /server and /server/port gone, one action
Expected reads:
  engine.get('/server') === undefined
```

### KING-06 — Ancestor: user edit auto-declines copilot child op

```
Initial state:
  engine = new Engine({ server: { port: 80 } })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/server/port', value: 8080 })
Action:
  us.propose({ kind: 'replace', path: '/server', value: { host: 'x' } })
Expected state:
  cs.ops = []   // auto-declined
  us.ops.length === 1
Expected reads:
  engine.get('/server') === { host: 'x' }
  cs.diff() === []
```

### KING-07 — Ancestor auto-decline cascades to subtree

```
Initial state:
  engine = new Engine({ server: { port: 80, host: 'old' } })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/server/port', value: 8080 })
  cs.propose({ kind: 'replace', path: '/server/host', value: 'copilot' })
Action:
  us.propose({ kind: 'replace', path: '/server', value: { fresh: true } })
Expected state:
  cs.ops = []   // BOTH copilot ops auto-declined
  us.ops.length === 1
Expected reads:
  engine.get('/server') === { fresh: true }
  cs.diff() === []
```

### KING-08 — Unrelated: both coexist

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'add', path: '/db/host', value: 'prod' })
Action:
  us.propose({ kind: 'add', path: '/cache/ttl', value: 300 })
Expected state:
  cs.ops.length === 1   // untouched
  us.ops.length === 1
Expected reads:
  engine.get('/db/host') === 'prod'   // still copilot layer
  engine.get('/cache/ttl') === 300
  cs.diff().length === 1
  cs.diff()[0].conflictsWithUser === undefined   // no conflict
```

---

## 7. The reverse direction: conflict flag (CONFLICT)

User edits first, then copilot proposes into overlapping territory. No auto-resolution; just flagging.

### CONFLICT-01 — Same path: flagged

```
Initial state:
  engine = new Engine({ timeout: 30 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/timeout', value: 45 })
  cs = us.startCopilot()
Action:
  cs.propose({ kind: 'replace', path: '/timeout', value: 60 })
Expected state:
  cs.ops.length === 1
  us.ops.length === 1   // user's op unchanged
Expected reads:
  cs.diff()[0].conflictsWithUser === true
  engine.get('/timeout') === 60   // copilot layer on top
```

### CONFLICT-02 — Approving a conflict clobbers user edit (last-write-wins)

```
Initial state:
  (as CONFLICT-01 after action)
Action:
  cs.approve('/timeout')
Expected state:
  cs.ops = []
  us.ops.length === 1   // user's op replaced by approved copilot op
Expected reads:
  engine.get('/timeout') === 60
  us.diff()[0].value === 60
Notes:
  The user is warned via the flag, but if they approve anyway, the
  copilot op wins. Engine does not block.
```

### CONFLICT-03 — Declining a conflict preserves user edit

```
Initial state:
  (as CONFLICT-01 after action)
Action:
  cs.decline('/timeout')
Expected state:
  cs.ops = []
  us.ops.length === 1   // user's original edit remains
Expected reads:
  engine.get('/timeout') === 45
```

### CONFLICT-04 — Ancestor overlap (user edited ancestor, copilot proposes descendant)

```
Initial state:
  engine = new Engine({ server: { port: 80 } })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/server', value: { host: 'x' } })
  cs = us.startCopilot()
Action:
  cs.propose({ kind: 'replace', path: '/server/port', value: 8080 })
Expected state:
  cs.ops.length === 1
Expected reads:
  cs.diff()[0].conflictsWithUser === true
```

### CONFLICT-05 — Descendant overlap (user edited descendant, copilot proposes ancestor)

```
Initial state:
  engine = new Engine({ server: { port: 80 } })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/server/port', value: 8080 })
  cs = us.startCopilot()
Action:
  cs.propose({ kind: 'replace', path: '/server', value: { host: 'x' } })
Expected state:
  cs.ops.length === 1
Expected reads:
  cs.diff()[0].conflictsWithUser === true
```

### CONFLICT-06 — No flag when paths unrelated

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  us.propose({ kind: 'add', path: '/a', value: 1 })
  cs = us.startCopilot()
Action:
  cs.propose({ kind: 'add', path: '/b', value: 2 })
Expected reads:
  cs.diff()[0].conflictsWithUser === undefined   // or false
```

---

## 8. Diffs and diffTree (DIFF)

### DIFF-01 — Empty session has empty diff

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
Expected reads:
  us.diff() === []
  us.diffTree() === { /* empty root */ }
```

### DIFF-02 — Diff returns insertion order

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
Action:
  us.propose({ kind: 'add', path: '/b', value: 2 })
  us.propose({ kind: 'add', path: '/a', value: 1 })
  us.propose({ kind: 'add', path: '/c', value: 3 })
Expected reads:
  us.diff().map(o => o.path) === ['/b', '/a', '/c']
```

### DIFF-03 — diffTree groups by path subtree

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  us.propose({ kind: 'add', path: '/db/host', value: 'x' })
  us.propose({ kind: 'add', path: '/cache/ttl', value: 300 })
  us.propose({ kind: 'add', path: '/db/port', value: 5432 })
Expected reads:
  us.diffTree() structure:
    root
      db
        host: add 'x'
        port: add 5432
      cache
        ttl: add 300
```

### DIFF-04 — Copilot diff vs user session, not base

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 3 })
Expected reads:
  cs.diff()[0].prev === 2      // previous value is user-layer, not base
  cs.diff()[0].value === 3
  cs.diff()[0].conflictsWithUser === true
```

---

## 9. Commit, export, and session finalization (COMMIT)

### COMMIT-01 — Commit with pending copilot session

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.commit()
Expected:
  throws CopilotSessionOpenError
Notes:
  Committing while copilot has unresolved ops is a bug.
  User must end() or approveAll() / declineAll() first.
```

### COMMIT-02 — Commit folds user ops and ends session

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
Action:
  us.commit()
Expected state:
  engine.activeUserSession() === null
Expected reads:
  engine.get('/a') === 2
  engine.export() === { a: 2 }
```

### COMMIT-03 — Multiple commits accumulate on base

```
Initial state:
  engine = new Engine({ a: 1 })
Action:
  us1 = engine.startUserSession()
  us1.propose({ kind: 'replace', path: '/a', value: 2 })
  us1.commit()
  us2 = engine.startUserSession()
  us2.propose({ kind: 'add', path: '/b', value: 10 })
  us2.commit()
Expected reads:
  engine.export() === { a: 2, b: 10 }
```

### COMMIT-04 — Discard leaves base unchanged

```
Initial state:
  engine = new Engine({ a: 1 })
Action:
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  us.discard()
Expected reads:
  engine.get('/a') === 1
  engine.export() === { a: 1 }
```

---

## 10. Cross-cutting interactions (INTERACT)

Higher-order scenarios that exercise multiple rules at once.

### INTERACT-01 — Full happy-path flow

```
Initial state:
  engine = new Engine({ timeout: 30, retries: 3 })
Action:
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/timeout', value: 45 })
  
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/retries', value: 5 })
  cs.propose({ kind: 'add', path: '/logLevel', value: 'debug' })
  
  cs.approve('/retries')
  cs.decline('/logLevel')
  cs.end()
  
  us.commit()
Expected reads:
  engine.export() === { timeout: 45, retries: 5 }
```

### INTERACT-02 — User edit auto-accepts copilot then reverts the tree

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.propose({ kind: 'add', path: '/server', value: { host: 'x' } })
Action:
  us.propose({ kind: 'add', path: '/server/port', value: 8080 })
  us.revert('/server')
Expected state:
  us.ops = []
  cs.ops = []   // still empty (was folded earlier)
Expected reads:
  engine.get('/server') === undefined
Notes:
  Demonstrates that auto-accepted copilot ops behave identically to
  user-authored ops after the fold — cascade, revert, undo all apply.
```

### INTERACT-03 — Undo across auto-accept boundary

```
Initial state:
  (as INTERACT-02 before revert; i.e. both /server and /server/port exist)
Action:
  us.undo()        // removes /server/port
  us.undo()        // removes /server (the auto-accepted op)
Expected state:
  us.ops = []
  us.redo.length === 2
Expected reads:
  engine.get('/server') === undefined
```

### INTERACT-04 — Copilot session handles conflict flag and user override in sequence

```
Initial state:
  engine = new Engine({ a: 1 })
  us = engine.startUserSession()
  us.propose({ kind: 'replace', path: '/a', value: 2 })
  cs = us.startCopilot()
  cs.propose({ kind: 'replace', path: '/a', value: 3 })  // conflictsWithUser = true
Action:
  us.propose({ kind: 'replace', path: '/a', value: 4 })  // user edits AFTER copilot
Expected state:
  cs.ops = []   // auto-declined per KING-01
  us.ops.length === 1   // user's latest op (value 4) is active
Expected reads:
  engine.get('/a') === 4
  cs.diff() === []
Notes:
  Demonstrates the temporal asymmetry: copilot-first sets the conflict
  flag; user-last auto-declines. The user's final action dominates.
```

---

## 11. Error cases (ERROR)

### ERROR-01 — Propose with invalid path (malformed pointer)

```
Action:
  us.propose({ kind: 'add', path: 'not-a-pointer', value: 1 })
Expected:
  throws InvalidPathError
```

### ERROR-02 — Add at a path whose parent does not exist

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
Action:
  us.propose({ kind: 'add', path: '/a/b/c', value: 1 })
Expected:
  throws ParentNotFoundError
  (or succeeds with implicit object creation — see DESIGN §8.3, undecided)
```

### ERROR-03 — Remove at a path that does not exist

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
Action:
  us.propose({ kind: 'remove', path: '/a', value: undefined })
Expected:
  throws PathNotFoundError
```

### ERROR-04 — Approve at a path not in copilot session

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
Action:
  cs.approve('/does-not-exist')
Expected:
  throws NoOpAtPathError
```

### ERROR-05 — Operating on ended session

```
Initial state:
  engine = new Engine({})
  us = engine.startUserSession()
  cs = us.startCopilot()
  cs.end()
Action:
  cs.propose({ kind: 'add', path: '/a', value: 1 })
Expected:
  throws SessionClosedError
```

---

## 12. Coverage summary

| Area       | Scenarios | Rules covered                                   |
|------------|-----------|-------------------------------------------------|
| BASIC      | 8         | Session lifecycle, base immutability, export    |
| IDENTITY   | 3         | §3.3 identity rule, shadowing                   |
| UNDO       | 5         | §3.5 undo/redo semantics                        |
| CASCADE    | 7         | §3.9 cascading revert                           |
| COPILOT    | 10        | §3.7 copilot review flow                        |
| KING       | 8         | §3.7 user-is-king matrix (4 cases × variants)   |
| CONFLICT   | 6         | §3.6 conflict flag                              |
| DIFF       | 4         | §3.6 diff and diffTree                          |
| COMMIT     | 4         | §3.8 commit and export                          |
| INTERACT   | 4         | Cross-cutting — multiple rules at once          |
| ERROR      | 5         | Error model (partial — see DESIGN §8.3)         |
| **Total**  | **64**    |                                                 |

Scenarios marked with "see DESIGN §8.x" depend on open questions and may change once those are resolved.

---

## 13. State machine view

For completeness, here is the engine state machine at a high level. Each node is a reachable engine state; each edge is a transition.

```
                    ┌──────────────────┐
                    │ NO SESSION       │
                    │ (base only)      │
                    └─────────┬────────┘
                              │ startUserSession()
                              ▼
                    ┌──────────────────┐
            ┌──────▶│ USER SESSION     │◀──────┐
            │       │ OPEN             │       │
  commit()  │       │ (drafting)       │       │ cs.end() /
  discard() │       └─────────┬────────┘       │ cs.approveAll() /
            │                 │ us.startCopilot()
            │                 ▼                │ cs.declineAll()
            │       ┌──────────────────┐       │
            │       │ COPILOT SESSION  │───────┘
            │       │ OPEN             │
            │       │ (reviewing)      │
            │       └─────────┬────────┘
            │                 │
            │   user ops, copilot ops,
            │   auto-accept/decline, approve,
            │   decline, undo, redo, revert
            │                 │
            │                 ▼
            │           (same state;
            │            internal data changes)
            ▼
    ┌──────────────────┐
    │ NO SESSION       │  (committed ops folded into base)
    │ (updated base)   │
    └──────────────────┘
```

The two states that matter at the API level are `NO SESSION`, `USER SESSION OPEN`, and `USER SESSION OPEN WITH COPILOT SESSION OPEN`. Everything else is internal state mutation within those three external states.
