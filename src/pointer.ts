import { InvalidPathError, PathNotFoundError } from './errors.js';
import type { KeyedElement } from './types.js';
import { isKeyedArray, toKeyed } from './types.js';

/**
 * Parse a JSON Pointer (RFC 6901) into an array of unescaped segments.
 * The empty string "" refers to the root.
 */
export function parsePath(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new InvalidPathError(path);
  }
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// ─── Keyed array helpers ────────────────────────────────────────────────────

/** Find a keyed element by its key. Returns the element or undefined. */
function findByKey(arr: KeyedElement[], key: string): KeyedElement | undefined {
  return arr.find((el) => el.key === key);
}

/** Find index of a keyed element by its key. Returns -1 if not found. */
function indexOfKey(arr: KeyedElement[], key: string): number {
  return arr.findIndex((el) => el.key === key);
}

/**
 * Wrap all arrays in a JSON value with keyed elements.
 * Returns the keyed value and the updated counter.
 */
export function keyify(value: unknown, counter: number): { value: unknown; counter: number } {
  if (Array.isArray(value)) {
    const keyed: KeyedElement[] = [];
    for (const item of value) {
      const result = keyify(item, counter);
      keyed.push({ key: String(counter), value: result.value });
      counter = result.counter + 1;
    }
    return { value: toKeyed(keyed), counter };
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      const result = keyify(rec[k], counter);
      out[k] = result.value;
      counter = result.counter;
    }
    return { value: out, counter };
  }
  return { value, counter };
}

/**
 * Strip keyed wrappers from a value, producing plain JSON.
 */
export function unkeyify(value: unknown): unknown {
  if (isKeyedArray(value)) {
    return value.map((el) => unkeyify(el.value));
  }
  // Empty array edge case — isKeyedArray returns false for empty arrays
  if (Array.isArray(value) && value.length === 0) {
    return [];
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      out[k] = unkeyify(rec[k]);
    }
    return out;
  }
  return value;
}

// ─── Path resolution (index ↔ key) ─────────────────────────────────────────

/**
 * Resolve an index-based path to a key-based path against a keyed object.
 * For non-array segments, passes through unchanged.
 * For array segments, resolves the numeric index (or '-') to the element's key.
 *
 * `opKind` is needed to handle 'add' at a new index (inserts get a new key).
 * Returns { segments, newKeys } where newKeys are any keys that were allocated
 * for 'add' operations (so the caller can assign them).
 */
export function resolveToKeyed(
  segments: string[],
  obj: unknown,
  counter: number,
  opKind: 'add' | 'remove' | 'replace',
): { segments: string[]; counter: number; insertAt?: number } {
  const resolved: string[] = [];
  let current = obj;
  let insertAt: number | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;

    if (isKeyedArray(current)) {
      if (isLast && opKind === 'add') {
        // Adding a new element — always allocate a new key for add
        const key = String(counter);
        resolved.push(key);
        counter++;
        insertAt = seg === '-' ? current.length : Number(seg);
        current = undefined;
      } else if (seg === '-') {
        // '-' in a non-add-at-end context: treat as last element
        const el = current[current.length - 1];
        if (!el) throw new PathNotFoundError('/' + segments.slice(0, i + 1).join('/'));
        resolved.push(el.key);
        current = el.value;
      } else {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
          throw new PathNotFoundError('/' + segments.slice(0, i + 1).join('/'));
        }
        resolved.push(current[idx].key);
        current = current[idx].value;
      }
    } else if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      resolved.push(seg);
      current = (current as Record<string, unknown>)[seg];
    } else {
      // Traversing into a primitive or null — the intermediate doesn't exist yet.
      // For 'add' ops this is fine (implicit parent creation); otherwise error.
      resolved.push(seg);
      current = undefined;
    }
  }

  return { segments: resolved, counter, insertAt };
}

/**
 * Resolve a key-based path back to an index-based path against a keyed object.
 * For non-array segments, passes through unchanged.
 * For array segments, resolves the key to its current positional index.
 */
export function resolveToIndex(segments: string[], obj: unknown): string[] {
  const resolved: string[] = [];
  let current = obj;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (isKeyedArray(current)) {
      const idx = indexOfKey(current, seg);
      if (idx === -1) {
        // Key not found in current state — might have been removed.
        // Return the key as-is (caller can handle).
        resolved.push(seg);
        current = undefined;
      } else {
        resolved.push(String(idx));
        current = current[idx].value;
      }
    } else if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      resolved.push(seg);
      current = (current as Record<string, unknown>)[seg];
    } else {
      resolved.push(seg);
      current = undefined;
    }
  }

  return resolved;
}

// ─── Keyed-aware get/set/remove ─────────────────────────────────────────────

/**
 * Get a value from a keyed object by key-based segments.
 * Keyed arrays are traversed by key; objects by property name.
 */
export function getBySegments(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (isKeyedArray(current)) {
      const el = findByKey(current, seg);
      if (!el) return undefined;
      current = el.value;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Get a value from a keyed object by JSON Pointer path (key-based). */
export function getByPath(obj: unknown, path: string): unknown {
  return getBySegments(obj, parsePath(path));
}

/**
 * Set a value in a keyed object by key-based segments (immutable — returns a new object).
 * For keyed arrays: if the key exists, update it; if not, append a new element with that key.
 * Creates intermediate objects as needed.
 */
export function setBySegments(
  obj: unknown,
  segments: string[],
  value: unknown,
  insertAt?: number,
): unknown {
  if (segments.length === 0) return value;

  const [head, ...rest] = segments;

  if (isKeyedArray(obj)) {
    const copy = obj.map((el) => ({ ...el }));
    const idx = indexOfKey(copy, head);
    if (idx !== -1) {
      // Update existing element
      copy[idx] = { key: head, value: setBySegments(copy[idx].value, rest, value) };
    } else {
      // New element — insert at specified position or append
      const newEl: KeyedElement = { key: head, value: rest.length === 0 ? value : setBySegments(undefined, rest, value) };
      if (insertAt !== undefined && insertAt < copy.length) {
        copy.splice(insertAt, 0, newEl);
      } else {
        copy.push(newEl);
      }
    }
    return toKeyed(copy);
  }

  // Object or creating a new object
  const rec: Record<string, unknown> = obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    ? { ...(obj as Record<string, unknown>) }
    : {};
  rec[head] = setBySegments(rec[head], rest, value, insertAt);
  return rec;
}

/**
 * Remove a key from a keyed object by key-based segments (immutable — returns a new object).
 * For keyed arrays: removes the element with the matching key (splice semantics — order preserved).
 */
export function removeBySegments(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    throw new PathNotFoundError('');
  }

  const [head, ...rest] = segments;

  if (rest.length === 0) {
    // Remove at this level
    if (isKeyedArray(obj)) {
      const idx = indexOfKey(obj, head);
      if (idx === -1) {
        throw new PathNotFoundError('/' + head);
      }
      const copy = [...obj];
      copy.splice(idx, 1);
      return toKeyed(copy);
    } else if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (!(head in rec)) {
        throw new PathNotFoundError('/' + head);
      }
      const { [head]: _, ...remaining } = rec;
      return remaining;
    }
    throw new PathNotFoundError('/' + head);
  }

  // Recurse
  if (isKeyedArray(obj)) {
    const idx = indexOfKey(obj, head);
    if (idx === -1) {
      throw new PathNotFoundError('/' + head);
    }
    const copy = obj.map((el) => ({ ...el }));
    copy[idx] = { key: head, value: removeBySegments(copy[idx].value, rest) };
    return toKeyed(copy);
  } else if (obj !== null && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    return { ...rec, [head]: removeBySegments(rec[head], rest) };
  }

  throw new PathNotFoundError('/' + segments.join('/'));
}

// ─── Path relationships ─────────────────────────────────────────────────────

/** Check if pathA is an ancestor of pathB. */
export function isAncestor(ancestorPath: string, descendantPath: string): boolean {
  if (ancestorPath === descendantPath) return false;
  if (ancestorPath === '') return true; // root is ancestor of everything
  return descendantPath.startsWith(ancestorPath + '/');
}

/** Check if pathA is a descendant of pathB. */
export function isDescendant(descendantPath: string, ancestorPath: string): boolean {
  return isAncestor(ancestorPath, descendantPath);
}

/** Check if two paths overlap: equal, ancestor, or descendant. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || isAncestor(a, b) || isAncestor(b, a);
}
