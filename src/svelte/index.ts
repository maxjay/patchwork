import { readable, derived, type Readable } from 'svelte/store';
import { Engine } from '../engine.js';
import type { EngineOptions } from '../types.js';

/**
 * Create an Engine and reactive stores for its state.
 *
 * ```svelte
 * <script>
 *   const { engine, version } = createEngine({ host: 'localhost', port: 8080 });
 *   $: config = ($version, engine.export());
 * </script>
 * ```
 */
export function createEngine<T = unknown>(
  base: T,
  opts?: EngineOptions<T>,
): { engine: Engine<T>; version: Readable<number> } {
  const engine = new Engine(base, opts);
  const version = engineStore(engine);
  return { engine, version };
}

/**
 * Create a readable store that tracks an Engine's version.
 * Auto-subscribes/unsubscribes.
 */
export function engineStore<T = unknown>(engine: Engine<T>): Readable<number> {
  return readable(engine.version, (set) => {
    return engine.onChange(() => set(engine.version));
  });
}

/**
 * Readable store for a value at a specific path. Only emits when
 * the value at this path actually changes.
 *
 * ```svelte
 * <script>
 *   const port = valueStore<number>(engine, '/server/port');
 * </script>
 * <input value={$port} />
 * ```
 */
export function valueStore<V = unknown>(engine: Engine, path: string): Readable<V> {
  return readable(engine.get(path) as V, (set) => {
    let lastJson = JSON.stringify(engine.get(path));
    return engine.onChange(() => {
      const value = engine.get(path);
      const json = JSON.stringify(value);
      if (json !== lastJson) {
        lastJson = json;
        set(value as V);
      }
    });
  });
}

/**
 * Readable store for the diff at a path.
 */
export function diffStore(
  engine: Engine,
  path: string,
): Readable<{ base: unknown; current: unknown } | null> {
  return readable(engine.getDiff(path), (set) => {
    let lastJson = JSON.stringify(engine.getDiff(path));
    return engine.onChange(() => {
      const diff = engine.getDiff(path);
      const json = JSON.stringify(diff);
      if (json !== lastJson) {
        lastJson = json;
        set(diff);
      }
    });
  });
}

/**
 * Readable store for the full exported document.
 */
export function exportStore<T = unknown>(engine: Engine<T>): Readable<T> {
  return readable(engine.export(), (set) => {
    let lastJson = JSON.stringify(engine.export());
    return engine.onChange(() => {
      const doc = engine.export();
      const json = JSON.stringify(doc);
      if (json !== lastJson) {
        lastJson = json;
        set(doc);
      }
    });
  });
}
