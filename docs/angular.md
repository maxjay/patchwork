# Angular Signals adapter

`@maxjay/patchwork/angular` wraps an `Engine` in a reactive store built on Angular Signals (Angular 16+). All reads are exposed as `Signal`s; all mutations fire those signals, so templates, computeds, and effects update automatically — no `ChangeDetectorRef`, no `NgZone`.

## Install

`@angular/core` is a peer dependency. The adapter ships with patchwork.

```bash
npm install @maxjay/patchwork @angular/core
```

The peer dep is optional — install patchwork without Angular if you only use the core engine. The adapter only loads if you import from `@maxjay/patchwork/angular`.

## Quick start

```ts
import { createPatchworkStore } from '@maxjay/patchwork/angular';

@Component({
  template: `
    <input [value]="port()" (input)="setPort($event)">
    <button (click)="store.accept()" [disabled]="!diff().length">Save</button>
    <button (click)="store.decline()" [disabled]="!diff().length">Discard</button>
  `,
})
class ServerSettings {
  store = createPatchworkStore({ server: { port: 8080 } });

  port = this.store.getValue<number>('$.server.port');
  diff = this.store.diff();

  setPort(e: Event) {
    this.store.replace('$.server.port', +(e.target as HTMLInputElement).value);
  }
}
```

## API

### `createPatchworkStore<T>(base, options?)`

Wraps a new `Engine` in a reactive store.

```ts
const store = createPatchworkStore<MyConfig>(initialDoc, { schema });
```

### `fromEngine<T>(engine)`

Wraps an existing `Engine`. Useful when the engine is created elsewhere — e.g., shared with non-Angular code, hydrated from a snapshot.

```ts
const engine = new Engine(initial);
const store = fromEngine(engine);
```

⚠️ Mutations applied directly to the wrapped engine bypass the reactive layer. Always go through the store.

### Reactive reads (return `Signal`)

| Method | Returns | Source |
|---|---|---|
| `store.draft` | `Signal<T>` | whole draft |
| `store.base` | `Signal<T>` | whole base |
| `store.get<U>(path)` | `Signal<Array<{path, value: U}>>` | draft, JSONPath query |
| `store.getBase<U>(path)` | `Signal<Array<{path, value: U}>>` | base, JSONPath query |
| `store.getValue<U>(path)` | `Signal<U>` | draft, strict single-match |
| `store.getValueBase<U>(path)` | `Signal<U>` | base, strict single-match |
| `store.diff(path?, options?)` | `Signal<DiffOp[]>` | structural diff — options: `key`, `includeUnchanged`, `cascade` |

#### Typed generics

The `<U>` type parameter is optional and defaults to `JsonValue`. Declare it to get a typed signal without a cast:

```ts
// Without generic — requires a cast at the call site
items = this.store.getValue('$.items') as Signal<Item[]>;

// With generic — typed directly
items = this.store.getValue<Item[]>('$.items');
groups  = this.store.getValue<Group[]>('$.groups');
members = this.store.getValue<Member[]>('$.members');
```

This works the same way for `get<U>`, `getBase<U>`, and `getValueBase<U>`.

#### Caching

Methods that take args (everything except `draft`/`base`) return a *new* `Signal` on each call. Assign once to a class field — don't call them in a template hot path. This is the same pattern as Angular's own `computed()`.

```ts
// ✅ Right — created once
port = this.store.getValue<number>('$.server.port');

// ❌ Wrong — new Signal per change-detection cycle
template: `{{ store.getValue('$.server.port')() }}`
```

### Mutations (sync, no return)

`add`, `replace`, `delete`, `move`, `copy`, `revert` — same signatures as `Engine`. Each fires the draft signal.

`restore(op)` — inverts a `DiffOp` from `diff()` and pushes it onto the undo stack. Fires the draft signal.

`undo`, `redo` — fire both draft and base signals.

`accept` — promotes draft to base, fires the base signal. `decline` — resets draft from base, fires the draft signal.

### Ephemeral sessions

`store.beginEphemeral()`, `store.commitEphemeral()`, `store.discardEphemeral()` — same semantics as `Engine`. Only available on root stores — `scope()` returns a store that throws on these. Use the root store for ephemeral.

### `store.scope<U>(path): PatchworkStore<U>`

Sub-store rooted at a subtree. Shares the parent's signal ticks — mutations through either side update both. Use to scope a component or feature module to a slice of the document without losing reactivity.

```ts
const network = store.scope<NetworkConfig>('$.network');
network.replace('$.timeout', 5000);
// store.draft().network.timeout === 5000 too
```

`network.accept()` commits the network subtree only — the rest of `base` stays put. `network.diff()` is automatically scoped to that subtree.

### `store.engine`

Escape hatch. Returns the underlying `Engine` or `NodeEngine`. Use for anything not surfaced through the store — but going around the store skips signal updates.

## Patterns

### Change-highlighting UI

`diff` doubles as both a "has unsaved changes" indicator and a per-row state source. With identity-keyed diffing, the `identity` field on `add`/`remove` ops tells you exactly which item was affected — no path parsing required:

```ts
@Component({
  template: `
    @for (item of items(); track item.id) {
      <div [class]="stateOf(item.id)">{{ item.name }}</div>
    }
    <button (click)="store.accept()" [disabled]="!diff().length">Save</button>
    <button (click)="store.decline()" [disabled]="!diff().length">Discard</button>
  `,
})
class ItemList {
  store = createPatchworkStore<any>(
    { items: [...] },
    {
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', 'x-key': 'id', items: { type: 'object' } },
        },
      },
    },
  );

  items = this.store.getValue<Item[]>('$.items');
  diff  = this.store.diff('$.items');

  stateOf(id: string): string {
    const ops = this.diff();
    if (ops.some(o => o.op === 'add'     && o.identity === id)) return 'added';
    if (ops.some(o => o.op === 'remove'  && o.identity === id)) return 'removed';
    if (ops.some(o => o.op === 'replace' && o.identity === id)) return 'modified';
    if (ops.some(o => o.op === 'move'    && o.identity === id)) return 'displaced';
    return 'unchanged';
  }
}
```

### Form binding with ephemeral commit

Bind input changes live but collapse to one undo entry on blur:

```ts
@Component({
  template: `<input
    [value]="port()"
    (focus)="store.beginEphemeral()"
    (input)="onInput($event)"
    (blur)="store.commitEphemeral()"
  >`,
})
class PortField {
  store = createPatchworkStore({ port: 8080 });
  port  = this.store.getValue<number>('$.port');

  onInput(e: Event) {
    this.store.replace('$.port', +(e.target as HTMLInputElement).value);
  }
}
```

One `undo()` snaps the field back to the value it had on focus. `discardEphemeral()` cancels instead — unwinds all session mutations with no history trace.

### Save / discard buttons

`diff` doubles as a "has unsaved changes" indicator:

```ts
hasChanges = computed(() => this.store.diff()().length > 0);
```

Or directly in the template:

```html
<button (click)="store.accept()" [disabled]="!diff().length">Save</button>
```

### Sharing across components

Put the store on a service:

```ts
@Injectable({ providedIn: 'root' })
class ConfigStore {
  private inner = createPatchworkStore<Config>(getInitial());

  readonly draft = this.inner.draft;
  readonly diff  = this.inner.diff();

  add(...args: Parameters<typeof this.inner.add>)         { this.inner.add(...args); }
  replace(...args: Parameters<typeof this.inner.replace>) { this.inner.replace(...args); }
  accept()  { this.inner.accept(); }
  decline() { this.inner.decline(); }
}
```

Any component that injects `ConfigStore` and reads its signals participates in the same reactive document.

### Scoped feature modules

Use `scope()` to give a feature module its own store view without wiring the full document:

```ts
@Injectable()
class NetworkSettingsStore {
  private root = inject(ConfigStore).inner;
  readonly store = this.root.scope<NetworkConfig>('$.network');

  readonly timeout = this.store.getValue<number>('$.timeout');
  readonly diff    = this.store.diff();
}
```

Mutations through `NetworkSettingsStore` are visible on the root store's signals, and vice versa. `store.accept()` commits only the network subtree.

## Notes on reactivity

The store updates engine state in-place (no `structuredClone` per mutation) and uses `equal: () => false` on its internal tick signals to force propagation regardless of reference equality. This keeps the hot path cheap — mutating 100 fields doesn't allocate 100 cloned documents — while keeping signal semantics correct.

If you read `engine.draft` directly (without going through the store), you get the same reference the store holds. Don't mutate it through the engine after that — the store's signal won't fire and the UI will desync. Always go through the store for writes.
