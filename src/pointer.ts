import { InvalidPathError, PathNotFoundError } from './errors.js';

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

// ─── Get / Set / Remove ─────────────────────────────────────────────────────

/** Get a value by path segments. */
export function getBySegments(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (seg === '-' || !Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Set a value by path segments. Immutable — returns a new structure. */
export function setBySegments(
  obj: unknown,
  segments: string[],
  value: unknown,
  insertAt?: number,
): unknown {
  if (segments.length === 0) return value;

  const [head, ...rest] = segments;

  if (Array.isArray(obj)) {
    const copy = [...obj];
    const idx = Number(head);
    if (Number.isInteger(idx) && idx >= 0 && idx < copy.length && insertAt === undefined) {
      // Replace existing element
      copy[idx] = setBySegments(copy[idx], rest, value);
    } else {
      // Insert new element
      const newVal = rest.length === 0 ? value : setBySegments(undefined, rest, value);
      if (insertAt !== undefined && insertAt < copy.length) {
        copy.splice(insertAt, 0, newVal);
      } else {
        copy.push(newVal);
      }
    }
    return copy;
  }

  const rec: Record<string, unknown> =
    obj !== null && typeof obj === 'object' && !Array.isArray(obj)
      ? { ...(obj as Record<string, unknown>) }
      : {};
  rec[head] = setBySegments(rec[head], rest, value, insertAt);
  return rec;
}

/** Remove by path segments. Immutable — returns a new structure. */
export function removeBySegments(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) throw new PathNotFoundError('');

  const [head, ...rest] = segments;

  if (rest.length === 0) {
    if (Array.isArray(obj)) {
      const idx = Number(head);
      if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) {
        throw new PathNotFoundError(buildPath([head]));
      }
      const copy = [...obj];
      copy.splice(idx, 1);
      return copy;
    }
    if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (!(head in rec)) throw new PathNotFoundError(buildPath([head]));
      const { [head]: _, ...remaining } = rec;
      return remaining;
    }
    throw new PathNotFoundError(buildPath([head]));
  }

  if (Array.isArray(obj)) {
    const idx = Number(head);
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) {
      throw new PathNotFoundError(buildPath([head]));
    }
    const copy = [...obj];
    copy[idx] = removeBySegments(copy[idx], rest);
    return copy;
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
