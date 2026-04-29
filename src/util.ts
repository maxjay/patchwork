/** Deep equality check for JSON-compatible values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, k) || !deepEqual(aRec[k], bRec[k])) return false;
  }
  return true;
}

/** Deep copy a JSON-compatible value. */
export function deepCopy<T>(value: T): T {
  return _deepCopy(value) as T;
}

function _deepCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(_deepCopy);
  }

  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    out[k] = _deepCopy(rec[k]);
  }
  return out;
}
