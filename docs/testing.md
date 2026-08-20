# Testing applications built on patchwork

Guidance for testing an app that depends on `@maxjay/patchwork` (or `@maxjay/patchwork/angular`) with vitest — what to mock, what not to, and the framework-level gotchas that actually bite.

---

## Don't mock the Engine

The single highest-value piece of advice here: **use the real `Engine`, not a hand-rolled mock.**

`Engine` has no module-level mutable state — every field (`undoStack`, `redoStack`, `keyMap`, `base`, `draft`) lives on the instance, initialized fresh in the constructor. Constructing one is synchronous, pure JS, no I/O, no timers, no randomness. That means:

- It's cheap to construct a fresh instance per test — there's no reason to share one across tests or fake it to "avoid the cost."
- It's safe under any parallelism model vitest offers — per-file worker isolation, `test.concurrent`, `describe.concurrent` — because two `Engine` instances never share anything.
- Its behavior (diffing, undo/redo, identity-keyed arrays, ephemeral sessions) is exactly what your app's logic was written and reviewed against. A mock has to reimplement that surface correctly to be worth anything, and it's easy to get subtly wrong — `x-key` identity diffing, the `revert()` union-of-base-and-draft-paths behavior, and ephemeral batching are all real edge cases a quick fake `{ replace: vi.fn() }` doesn't capture.

If you've hit **intermittent failures under `vi.mock` + parallel test runs**, the near-universal cause is a mock factory that captures *shared mutable state* at module scope instead of creating a fresh instance per test:

```ts
// ❌ Bug: one Engine/store instance shared by every test in the file.
// vi.mock factories run once and are cached — this line runs once, not per-test.
vi.mock('@maxjay/patchwork', () => {
  const engine = new Engine({ items: [] }); // constructed ONCE, reused by every test
  return { createEngine: () => engine };
});
```
Sequentially this can *look* like it works (each test happens to run after the previous one's mutations, in an order that hides the bug) — which is exactly why it tends to surface specifically when tests run out of original order or concurrently (`test.concurrent`, `describe.concurrent`, or just a different worker/file ordering in CI vs. locally): the shared instance's `draft`/`undoStack` carries state across tests that were never designed to share it. The fix isn't a better mock — it's not mocking the engine at all:

```ts
// ✅ Fresh, real Engine per test. No shared state, no reimplemented semantics.
beforeEach(() => {
  engine = new Engine(fixture());
});
```

Reserve `vi.mock` for what it's actually for: I/O boundaries. Patchwork has none — no network, no timers, no filesystem. There's nothing to mock.

---

## The actual surface area

If you're building a test double anyway (e.g. to isolate a UI component from a schema/fixture you don't want to construct in every test), here's what's actually load-bearing versus what most consumers never touch directly.

### Core (`Engine` / `NodeEngine`)

| Member | Used by typical apps? | Notes |
|---|---|---|
| `.base`, `.draft` | Yes — the two things every component reads | Plain JSON, not the Engine itself |
| `.get`, `.getValue`, `.getBase`, `.getValueBase` | Yes | Pure reads, no side effects |
| `.add`, `.replace`, `.delete`, `.move`, `.copy`, `.revert` | Yes — the mutation surface | All synchronous, all pushed onto the undo stack |
| `.undo`, `.redo` | Yes, if you expose undo/redo in the UI | |
| `.accept`, `.decline` | Yes — the commit/discard boundary | |
| `.diff` | Yes — almost every "has changes" / change-highlighting UI | Pure function of `base`/`draft`; safe to call repeatedly |
| `.beginEphemeral` / `.commitEphemeral` / `.discardEphemeral` | Sometimes — streaming/form-binding UIs | Root `Engine` only, not `NodeEngine` |
| `.getNodeEngine` / scoped lenses | Sometimes — feature-module scoping | |
| `.exportChanges` / `.importChanges` / `.restore` | Sometimes — persistence, review UIs | |
| `pushOperation`, `segmentsFrom`, `getAt` (marked `@internal`) | No | Don't test against these directly; they can change without a semver bump |

If you're writing a fake for component isolation, the 80% case is: `draft`, `diff`, and whichever of `add`/`replace`/`delete`/`accept`/`decline` your component actually calls. You almost never need to fake `move`/`copy`/`revert`/ephemeral/scoping unless the component under test specifically exercises them — don't build those into a shared fake "just in case," it's exactly the kind of unused surface that drifts from reality unnoticed.

### Angular adapter (`PatchworkStore`)

Same shape as `Engine`, but every read is a `Signal`. The one thing worth internalizing: **`store.draft`, `store.diff()`, etc. are plain `computed()` signals** — they need no `TestBed`, no injection context, no zone. You can unit test a component's derived state with a bare `computed()` read, exactly the way `angular.test.ts` in this repo does it:

```ts
const store = createPatchworkStore({ port: 8080 });
const doubled = computed(() => store.draft().port * 2);
store.replace('$.port', 443);
expect(doubled()).toBe(886); // synchronous, no TestBed needed
```

`TestBed` only enters the picture once you use `effect()` — see below.

---

## Snapshot-testing `diff()` output

`diff()`'s output order follows the *source objects'* own key-insertion order (it unions keys via `Object.keys`). Two fixtures with the same data but different key order can legitimately produce the same `DiffOp`s in a different array order — which shows up as a spurious `toMatchSnapshot()` diff that has nothing to do with a real behavior change.

`sortDiff()` (exported from `@maxjay/patchwork`) gives you a deterministic order — by path, then by a fixed op-type priority as a tiebreaker for same-path collisions (e.g. a `remove` and a same-index `replace` from a surviving identity-keyed element):

```ts
import { sortDiff } from '@maxjay/patchwork';

expect(sortDiff(engine.diff())).toMatchSnapshot();
```

Prefer this over asserting on raw `diff()` array order in any test — including non-snapshot `toEqual` assertions on multi-op diffs, for the same reason.

---

## Angular: `effect()` needs `TestBed`, plain signals don't

Two different testing regimes, and mixing them up is the most common Angular-testing gotcha with this store:

**Reading `store.draft` / `store.diff()` / `store.getValue()` directly** — no `TestBed` required. These are `computed()` signals; call them like functions in a plain vitest test.

**Wrapping a store signal in `effect()`** (e.g. testing an `@Injectable` service that reacts to `store.diff()` internally) — `effect()` throws `NG0203: effect() can only be used within an injection context` if called bare. The fix is the standard Angular testing pattern, nothing patchwork-specific:

```ts
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { effect } from '@angular/core';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()); // once, in test setup

it('effect observes a store mutation', () => {
  TestBed.configureTestingModule({ providers: [] });
  const store = createPatchworkStore({ x: 1 });
  const seen: number[] = [];

  TestBed.runInInjectionContext(() => {
    effect(() => seen.push(store.draft().x));
  });

  TestBed.tick();               // flush the effect's initial run
  expect(seen).toEqual([1]);

  store.replace('$.x', 2);      // signal write is synchronous...
  TestBed.tick();                // ...but the effect callback needs a flush to see it
  expect(seen).toEqual([1, 2]);
});
```

`TestBed.tick()` is the part people forget: `store.draft()` reflects a mutation immediately (it's a synchronous signal write), but an `effect()` reading it does not run synchronously — it's scheduled, and needs a flush (`TestBed.tick()`, or `fixture.detectChanges()` / `await fixture.whenStable()` in a full component test) before you can assert on its side effects. This is standard Angular signal-scheduling behavior, not something patchwork changes or needs to work around — once `TestBed` is initialized the normal way (which any Angular app testing components already does), `effect()` against a `PatchworkStore` needs no extra provider or setup beyond that.

If you're only testing what a component *renders* (not raw `effect()` behavior), the same rule applies one level up: a `store.replace(...)` call inside a component test updates `store.draft()` immediately, but the rendered DOM won't reflect it until `fixture.detectChanges()` runs.

---

## Everything else is a normal vitest/Node concern, not a patchwork one

A few things that look like they might be patchwork-specific but aren't, worth ruling out before chasing them as library bugs:

- **`structuredClone` under `jsdom`/`happy-dom`** — works fine; vitest's DOM environments expose the real global. Not a source of flakiness.
- **ESM-only package** (`"type": "module"`, no `require` export condition) — works fine under vitest (Vite-native ESM) and under modern Node's `require(esm)` support. Only bites if your app or CI pins a Node version old enough to lack that (pre-22.12) *and* something in your pipeline forces a `require()` of this package specifically.
- **Random/generated IDs in `x-key`-keyed fixtures** — if your test fixtures generate IDs via `crypto.randomUUID()` or similar per run, assertions on `DiffOp.identity` will be flaky by construction. Pin IDs in fixtures, not a patchwork concern.
