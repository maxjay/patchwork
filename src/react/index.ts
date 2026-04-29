import { useSyncExternalStore, useRef, useMemo } from 'react';
import { Engine } from '../engine.js';
import type { EngineOptions, NodeInfo } from '../types.js';
import { deepEqual } from '../util.js';

/**
 * Create an Engine and subscribe to its changes.
 * The component re-renders on every engine change.
 */
export function useEngine<T = unknown>(base: T, opts?: EngineOptions<T>): Engine<T> {
  const ref = useRef<Engine<T>>(undefined);
  if (!ref.current) ref.current = new Engine(base, opts);
  useEngineState(ref.current);
  return ref.current;
}

/**
 * Subscribe to an existing Engine. Re-renders on any change.
 */
export function useEngineState<T = unknown>(engine: Engine<T>): void {
  useSyncExternalStore(
    (cb) => engine.onChange(cb),
    () => engine.version,
  );
}

/**
 * Read a value at a path, reactively. Only re-renders when the value
 * at this specific path changes — not on every engine change.
 *
 * ```tsx
 * const port = useValue<number>(engine, '/server/port');
 * ```
 */
export function useValue<V = unknown>(engine: Engine, path: string): V {
  const sel = useMemo(() => makeSelector<V>(engine, () => engine.get(path) as V), [engine, path]);
  return useSyncExternalStore(sel.subscribe, sel.snap);
}

/**
 * Read the diff at a path, reactively. Returns `{ base, current }` if
 * the value differs from base, or `null` if unchanged.
 */
export function useDiff(
  engine: Engine,
  path: string,
): { base: unknown; current: unknown } | null {
  const sel = useMemo(() => makeSelector(engine, () => engine.getDiff(path)), [engine, path]);
  return useSyncExternalStore(sel.subscribe, sel.snap);
}

/**
 * Read the node metadata at a path, reactively.
 *
 * For containers (object/array): re-renders when keys are added/removed.
 * For leaves: re-renders when the value changes.
 * Returns `null` if the path doesn't exist.
 *
 * ```tsx
 * const node = useNode(engine, '/server');
 * if (node?.keys) { /* render children *\/ }
 * ```
 */
export function useNode(engine: Engine, path: string): NodeInfo | null {
  const sel = useMemo(() => makeSelector(engine, () => engine.node(path)), [engine, path]);
  return useSyncExternalStore(sel.subscribe, sel.snap);
}

/**
 * Read the full exported document, reactively. Only re-renders when the
 * document actually changes.
 */
export function useExport<T = unknown>(engine: Engine<T>): T {
  const sel = useMemo(() => makeSelector<T>(engine, () => engine.export()), [engine]);
  return useSyncExternalStore(sel.subscribe, sel.snap);
}

// ─── Internal ──────────────────────────────────────────────────────────────────

function makeSelector<V>(engine: Engine<any>, compute: () => V) {
  let ver = -1;
  let value: V;

  return {
    subscribe: (cb: () => void) => engine.onChange(cb),
    snap: (): V => {
      if (engine.version === ver) return value;
      const next = compute();
      ver = engine.version;
      if (!deepEqual(next, value)) {
        value = next;
      }
      return value;
    },
  };
}
