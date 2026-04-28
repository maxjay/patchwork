import { Engine } from '../engine.js';
import type { EngineOptions } from '../types.js';

/**
 * Minimal observable interface — compatible with Angular's `async` pipe,
 * RxJS `from()`, and `toSignal()`. No @angular/core or rxjs dependency.
 */
export interface Subscribable<T> {
  subscribe(observer: { next: (value: T) => void }): { unsubscribe: () => void };
}

/**
 * Create an Engine and an observable that tracks its version.
 *
 * ```ts
 * // In a component or service
 * const { engine, version$ } = createEngine({ host: 'localhost', port: 8080 });
 * readonly version = toSignal(version$);
 * ```
 */
export function createEngine<T = unknown>(
  base: T,
  opts?: EngineOptions<T>,
): { engine: Engine<T>; version$: Subscribable<number> } {
  const engine = new Engine(base, opts);
  return { engine, version$: observeVersion(engine) };
}

/**
 * Observable of the engine's version number. Emits on every change.
 */
export function observeVersion<T = unknown>(engine: Engine<T>): Subscribable<number> {
  return {
    subscribe(observer) {
      observer.next(engine.version);
      const unsub = engine.onChange(() => observer.next(engine.version));
      return { unsubscribe: unsub };
    },
  };
}

/**
 * Observable of a value at a specific path. Only emits when the value
 * at this path actually changes.
 *
 * ```ts
 * readonly port = toSignal(observeValue<number>(engine, '/server/port'));
 * ```
 */
export function observeValue<V = unknown>(engine: Engine, path: string): Subscribable<V> {
  return {
    subscribe(observer) {
      let lastJson = JSON.stringify(engine.get(path));
      observer.next(engine.get(path) as V);
      const unsub = engine.onChange(() => {
        const value = engine.get(path);
        const json = JSON.stringify(value);
        if (json !== lastJson) {
          lastJson = json;
          observer.next(value as V);
        }
      });
      return { unsubscribe: unsub };
    },
  };
}

/**
 * Observable of the diff at a path. Emits `{ base, current }` or null.
 */
export function observeDiff(
  engine: Engine,
  path: string,
): Subscribable<{ base: unknown; current: unknown } | null> {
  return {
    subscribe(observer) {
      let lastJson = JSON.stringify(engine.getDiff(path));
      observer.next(engine.getDiff(path));
      const unsub = engine.onChange(() => {
        const diff = engine.getDiff(path);
        const json = JSON.stringify(diff);
        if (json !== lastJson) {
          lastJson = json;
          observer.next(diff);
        }
      });
      return { unsubscribe: unsub };
    },
  };
}

/**
 * Observable of the full exported document. Only emits when the document
 * actually changes.
 */
export function observeExport<T = unknown>(engine: Engine<T>): Subscribable<T> {
  return {
    subscribe(observer) {
      let lastJson = JSON.stringify(engine.export());
      observer.next(engine.export());
      const unsub = engine.onChange(() => {
        const doc = engine.export();
        const json = JSON.stringify(doc);
        if (json !== lastJson) {
          lastJson = json;
          observer.next(doc);
        }
      });
      return { unsubscribe: unsub };
    },
  };
}
