import { KEYED } from './types.js';

/** Deep copy that preserves keyed array tags. */
export function deepCopy<T>(value: T): T {
  return _deepCopy(value) as T;
}

function _deepCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const copy = value.map(_deepCopy);
    if ((value as any)[KEYED]) {
      (copy as any)[KEYED] = true;
    }
    return copy;
  }

  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    out[k] = _deepCopy(rec[k]);
  }
  return out;
}
