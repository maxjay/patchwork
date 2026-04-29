import { ref, computed, onScopeDispose, type Ref, type ComputedRef } from 'vue';
import { Engine } from '../engine.js';

/**
 * Create an Engine and subscribe to its changes.
 *
 * ```ts
 * const { engine } = useEngine({ host: 'localhost', port: 8080 });
 * ```
 */
export function useEngine<T = unknown>(
  base: T,
  schema?: object,
): { engine: Engine<T>; version: Ref<number> } {
  const engine = new Engine(base, schema);
  const version = useEngineState(engine);
  return { engine, version };
}

/**
 * Subscribe to an existing Engine. Returns a reactive version ref.
 */
export function useEngineState<T = unknown>(engine: Engine<T>): Ref<number> {
  const version = ref(engine.version);
  const unsub = engine.onChange(() => { version.value = engine.version; });
  onScopeDispose(unsub);
  return version;
}

/**
 * Read a value at a path as a computed ref. Recomputes only when the
 * engine version changes, and Vue's own equality check prevents
 * dependent effects from running if the result is the same primitive.
 *
 * ```ts
 * const port = useValue<number>(engine, '/server/port');
 * // port.value is reactive
 * ```
 */
export function useValue<V = unknown>(engine: Engine, path: string): ComputedRef<V> {
  const version = useEngineState(engine);
  return computed(() => {
    void version.value; // track
    return engine.get(path) as V;
  });
}

/**
 * Read the diff at a path as a computed ref. Returns `{ base, current }` or null.
 */
export function useDiff(
  engine: Engine,
  path: string,
): ComputedRef<{ base: unknown; current: unknown } | null> {
  const version = useEngineState(engine);
  return computed(() => {
    void version.value;
    return engine.getDiff(path);
  });
}

/**
 * Read the full exported document as a computed ref.
 */
export function useExport<T = unknown>(engine: Engine<T>): ComputedRef<T> {
  const version = useEngineState(engine);
  return computed(() => {
    void version.value;
    return engine.export();
  });
}
