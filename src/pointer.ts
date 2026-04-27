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

/**
 * Build a JSON Pointer from segments, applying RFC 6901 escaping.
 */
export function buildPath(segments: string[]): string {
  if (segments.length === 0) return '';
  return '/' + segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

// ─── Keyed arrays ───────────────────────────────────────────────────────────
//
// Arrays are the one special case. Object paths pass through as-is.
// Only when a path traverses an array do we need to translate between
// the caller's index-based path and the engine's key-based internal path.

/** Returns true if the value contains any array (at any depth). */
export function containsArray(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsArray);
  }
  return false;
}

/**
 * Wrap all arrays in a JSON value with keyed elements.
 * Only call this when the value actually contains arrays.
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

/** Strip keyed wrappers, producing plain JSON. */
export function unkeyify(value: unknown): unknown {
  if (isKeyedArray(value)) {
    return value.map((el) => unkeyify(el.value));
  }
  if (Array.isArray(value) && value.length === 0) return [];
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

/**
 * Resolve an index-based path to an internal path.
 *
 * Walks `obj` (the current internal state) segment by segment.
 * Object segments pass through unchanged. Array segments translate
 * the numeric index to the element's stable key.
 *
 * For `add` ops targeting an array, a new key is allocated and
 * `insertAt` records where to splice the new element.
 */
export function resolveToInternal(
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
      // Array segment — translate index to key
      if (isLast && opKind === 'add') {
        // New element: allocate a key, record insertion position
        resolved.push(String(counter));
        insertAt = seg === '-' ? current.length : Number(seg);
        counter++;
        current = undefined;
      } else if (seg === '-') {
        const el = current[current.length - 1];
        if (!el) throw new PathNotFoundError(buildPath(segments.slice(0, i + 1)));
        resolved.push(el.key);
        current = el.value;
      } else {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
          throw new PathNotFoundError(buildPath(segments.slice(0, i + 1)));
        }
        resolved.push(current[idx].key);
        current = current[idx].value;
      }
    } else if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      // Object segment — pass through
      resolved.push(seg);
      current = (current as Record<string, unknown>)[seg];
    } else {
      // Path goes through a primitive or undefined (implicit parent creation for add)
      resolved.push(seg);
      current = undefined;
    }
  }

  return { segments: resolved, counter, insertAt };
}

/**
 * Resolve an internal (key-based) path back to an index-based path.
 * Only array segments change — keys become positional indices.
 * Object segments pass through unchanged.
 */
export function resolveToExternal(segments: string[], obj: unknown): string[] {
  const resolved: string[] = [];
  let current = obj;

  for (const seg of segments) {
    if (isKeyedArray(current)) {
      const idx = current.findIndex((el) => el.key === seg);
      if (idx === -1) {
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

// ─── Internal-path get/set/remove ───────────────────────────────────────────
//
// These operate on the keyed internal representation.
// Array segments are element keys; object segments are property names.

/** Get a value by internal path segments. */
export function getBySegments(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (isKeyedArray(current)) {
      const el = current.find((e) => e.key === seg);
      current = el ? el.value : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Set a value by internal path segments. Immutable — returns a new structure. */
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
    const idx = copy.findIndex((el) => el.key === head);
    if (idx !== -1) {
      copy[idx] = { key: head, value: setBySegments(copy[idx].value, rest, value) };
    } else {
      const newEl: KeyedElement = {
        key: head,
        value: rest.length === 0 ? value : setBySegments(undefined, rest, value),
      };
      if (insertAt !== undefined && insertAt < copy.length) {
        copy.splice(insertAt, 0, newEl);
      } else {
        copy.push(newEl);
      }
    }
    return toKeyed(copy);
  }

  const rec: Record<string, unknown> =
    obj !== null && typeof obj === 'object' && !Array.isArray(obj)
      ? { ...(obj as Record<string, unknown>) }
      : {};
  rec[head] = setBySegments(rec[head], rest, value, insertAt);
  return rec;
}

/** Remove by internal path segments. Immutable — returns a new structure. */
export function removeBySegments(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) throw new PathNotFoundError('');

  const [head, ...rest] = segments;

  if (rest.length === 0) {
    if (isKeyedArray(obj)) {
      const idx = obj.findIndex((el) => el.key === head);
      if (idx === -1) throw new PathNotFoundError(buildPath([head]));
      const copy = [...obj];
      copy.splice(idx, 1);
      return toKeyed(copy);
    }
    if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (!(head in rec)) throw new PathNotFoundError(buildPath([head]));
      const { [head]: _, ...remaining } = rec;
      return remaining;
    }
    throw new PathNotFoundError(buildPath([head]));
  }

  if (isKeyedArray(obj)) {
    const idx = obj.findIndex((el) => el.key === head);
    if (idx === -1) throw new PathNotFoundError(buildPath([head]));
    const copy = obj.map((el) => ({ ...el }));
    copy[idx] = { key: head, value: removeBySegments(copy[idx].value, rest) };
    return toKeyed(copy);
  }
  if (obj !== null && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    return { ...rec, [head]: removeBySegments(rec[head], rest) };
  }

  throw new PathNotFoundError(buildPath(segments));
}

// ─── Path relationships ─────────────────────────────────────────────────────

export function isAncestor(ancestorPath: string, descendantPath: string): boolean {
  if (ancestorPath === descendantPath) return false;
  if (ancestorPath === '') return true;
  return descendantPath.startsWith(ancestorPath + '/');
}

export function isDescendant(descendantPath: string, ancestorPath: string): boolean {
  return isAncestor(ancestorPath, descendantPath);
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || isAncestor(a, b) || isAncestor(b, a);
}
