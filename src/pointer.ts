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

/** Get a value from a plain JSON object by parsed segments. */
export function getBySegments(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Get a value from a plain JSON object by JSON Pointer path. */
export function getByPath(obj: unknown, path: string): unknown {
  return getBySegments(obj, parsePath(path));
}

/**
 * Set a value in a plain JSON object by parsed segments (immutable — returns a new object).
 * Creates intermediate objects/arrays as needed.
 */
export function setBySegments(obj: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value;

  const [head, ...rest] = segments;
  const isArray = Array.isArray(obj);
  const container: Record<string, unknown> | unknown[] = isArray
    ? [...(obj as unknown[])]
    : { ...(obj as Record<string, unknown> ?? {}) };

  if (isArray) {
    const idx = head === '-' ? (container as unknown[]).length : Number(head);
    (container as unknown[])[idx] = setBySegments((container as unknown[])[idx], rest, value);
  } else {
    (container as Record<string, unknown>)[head] = setBySegments(
      (container as Record<string, unknown>)[head],
      rest,
      value,
    );
  }

  return container;
}

/**
 * Remove a key/index from a plain JSON object by parsed segments (immutable — returns a new object).
 * Throws PathNotFoundError if the target does not exist.
 */
export function removeBySegments(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    throw new PathNotFoundError('');
  }

  const [head, ...rest] = segments;

  if (rest.length === 0) {
    // Remove at this level
    if (Array.isArray(obj)) {
      const idx = Number(head);
      if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) {
        throw new PathNotFoundError('/' + head);
      }
      const copy = [...obj];
      copy.splice(idx, 1);
      return copy;
    } else if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (!(head in rec)) {
        throw new PathNotFoundError('/' + head);
      }
      const { [head]: _, ...rest } = rec;
      return rest;
    }
    throw new PathNotFoundError('/' + head);
  }

  // Recurse
  if (Array.isArray(obj)) {
    const idx = Number(head);
    const copy = [...obj];
    copy[idx] = removeBySegments(copy[idx], rest);
    return copy;
  } else if (obj !== null && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    return { ...rec, [head]: removeBySegments(rec[head], rest) };
  }

  throw new PathNotFoundError('/' + segments.join('/'));
}

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
