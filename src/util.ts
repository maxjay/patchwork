/** Deep copy via structured clone (available in Node 17+ and all modern browsers). */
export function deepCopy<T>(value: T): T {
  return structuredClone(value);
}
