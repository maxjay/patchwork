// Path and segment machinery, kept out of the engine so engine.ts contains
// no string-building or escaping knowledge.
//
// Division of labor with jsonpath-rfc9535: the library owns everything the
// RFC defines — parsing, query evaluation (paths()), and the Normalized Path
// output format. This module owns the one thing the RFC cannot express:
// identity addressing inside keyed (x-key) arrays. RFC 9535 Normalized Paths
// are restricted to name and index segments, and an index cannot address a
// keyed element coherently (a removed element only has a position in base,
// an added one only in draft) — so paths that cross a keyed array serialize
// the element segment as an identity filter instead. Those are valid RFC
// 9535 queries the library evaluates natively; they are just not something
// any conformant library will ever produce.

import type { JsonValue } from 'jsonpath-rfc9535';

export function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An identity segment addresses an element of a keyed array by its x-key
// value instead of its position. key === null means x-key: '$self' (the item
// is its own identity). Indexes inside keyed arrays go stale on the next
// splice and differ between base and draft, so identity is the only address
// that crosses the engine boundary.
export type IdentitySeg = { key: string | null; value: JsonValue };
export type Seg = string | number | IdentitySeg;

// Escape rules for name segments, vendored from jsonpath-rfc9535
// (dist/esm/core/path.js, Apache-2.0) so our output is byte-compatible with
// the library's normalized paths. The library implements this internally
// (toNormalizedKey) but does not export it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars must be escaped
const NAME_ESCAPE_REGEX = /[\u0000-\u001f'\\]/g;
function escapeNameChar(ch: string): string {
	const code = ch.charCodeAt(0);
	switch (code) {
		case 0x8: return '\\b';
		case 0xc: return '\\f';
		case 0xa: return '\\n';
		case 0xd: return '\\r';
		case 0x9: return '\\t';
		case 0x27: return "\\'";
		case 0x5c: return '\\\\';
		default: return `\\u${code.toString(16).padStart(4, '0')}`;
	}
}
export function escapeName(name: string): string {
	return name.replace(NAME_ESCAPE_REGEX, escapeNameChar);
}

// The single place path strings are built. Name/index segments follow the
// library's normalized form; identity segments serialize as RFC 9535 filter
// selectors, e.g. [?@['email'] == "b@x.com"]. JSON.stringify covers the
// filter literal: RFC 9535 double-quoted string escapes are JSON-compatible,
// and numbers/booleans/null serialize bare.
export function segsToPath(segs: Seg[]): string {
	let out = '$';
	for (const seg of segs) {
		if (typeof seg === 'number') out += `[${seg}]`;
		else if (typeof seg === 'string') out += `['${escapeName(seg)}']`;
		else if (seg.key === null) out += `[?@ == ${JSON.stringify(seg.value)}]`;
		else out += `[?@['${escapeName(seg.key)}'] == ${JSON.stringify(seg.value)}]`;
	}
	return out;
}

// The two appenders for the keyMap pattern micro-format: any array position
// (index or identity) is [*], object keys are ['name']. Every builder of
// pattern strings — the schema walker, the diff walk, canonicalization —
// goes through these so the format cannot drift between sites.
export function patternChild(pattern: string, key: string): string {
	return `${pattern}['${key}']`;
}
export function patternElement(pattern: string): string {
	return `${pattern}[*]`;
}

// Pattern form of a parsed segment list. Built from segments, never by
// rewriting path strings — a property literally named "x[0]" can't fool it.
export function segmentsToPattern(segments: (string | number)[]): string {
	let out = '$';
	for (const seg of segments) {
		out = typeof seg === 'number' ? patternElement(out) : patternChild(out, seg);
	}
	return out;
}

// String prefix helpers.
//
// Serialized paths always end with `]` after the root token, so segment
// boundaries are unambiguous from raw string comparison:
//   prefix      $['cars']
//   sibling     $['carsTrucks']   — does NOT start with prefix + '['
//   child       $['cars'][0]      — DOES start with prefix + '['
//   self        $['cars']         — equals prefix exactly

export function joinPath(prefix: string, childPath: string): string {
	// childPath always starts with $; strip it and concat to prefix
	return prefix + childPath.slice(1);
}

export function rebasePath(fullPath: string, prefix: string): string {
	if (fullPath === prefix) return '$';
	return '$' + fullPath.slice(prefix.length);
}

export function isUnderPrefix(fullPath: string, prefix: string): boolean {
	return fullPath === prefix || fullPath.startsWith(prefix + '[');
}

// Converts a concrete index segment list (parsed from a paths() result) into
// canonical form: positions inside keyed arrays become identity segments,
// read off the element in `doc`. Object keys and unkeyed indexes pass
// through. The library cannot do this step — it requires the x-key map.
export function canonicalizeSegs(
	doc: JsonValue,
	keyMap: Map<string, string>,
	segments: (string | number)[],
): Seg[] {
	const out: Seg[] = [];
	let pattern = '$';
	let cur: any = doc;
	for (const seg of segments) {
		if (typeof seg === 'number') {
			const key = Array.isArray(cur) ? keyMap.get(pattern) : undefined;
			const item = Array.isArray(cur) ? cur[seg] : undefined;
			if (key === '$self') out.push({ key: null, value: item });
			else if (key !== undefined && isPlainObject(item) && item[key] !== undefined) out.push({ key, value: item[key] });
			else out.push(seg);
			pattern = patternElement(pattern);
		} else {
			out.push(seg);
			pattern = patternChild(pattern, seg);
		}
		cur = cur === null || cur === undefined ? undefined : cur[seg];
	}
	return out;
}

// Inverse of canonicalizeSegs: resolves a canonical segment list against a
// document, mapping identity segments back to concrete indexes by scanning
// the array for the matching key value. Returns undefined when any hop is
// missing. Resolution is always fresh — never cached across mutations.
export function resolveCanonical(doc: JsonValue, segs: Seg[]): (string | number)[] | undefined {
	const out: (string | number)[] = [];
	let cur: any = doc;
	for (const seg of segs) {
		if (cur === null || typeof cur !== 'object') return undefined;
		if (typeof seg === 'object') {
			if (!Array.isArray(cur)) return undefined;
			const idx = cur.findIndex((item: any) =>
				seg.key === null ? item === seg.value : isPlainObject(item) && item[seg.key] === seg.value,
			);
			if (idx === -1) return undefined;
			out.push(idx);
			cur = cur[idx];
		} else if (typeof seg === 'number') {
			if (!Array.isArray(cur) || seg < 0 || seg >= cur.length) return undefined;
			out.push(seg);
			cur = cur[seg];
		} else {
			if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
			out.push(seg);
			cur = cur[seg];
		}
	}
	return out;
}

// Reads the identity of an array element under a given identity segment's
// key ($self: the item is its own identity).
export function identityOf(item: JsonValue, seg: IdentitySeg): JsonValue | undefined {
	return seg.key === null ? item : isPlainObject(item) ? item[seg.key] : undefined;
}

// Where a reverted removal re-inserts: directly after the nearest preceding
// base neighbor that survives in `sequence` — the identity sequence the
// draft array will have at insertion time — or at 0 when none survive, so an
// un-deleted element comes back next to the elements it lived beside instead
// of teleporting to the end of the list.
export function ghostInsertIndex(baseArr: JsonValue[], sequence: Array<JsonValue | undefined>, seg: IdentitySeg): number {
	const baseIdx = baseArr.findIndex(item => identityOf(item, seg) === seg.value);
	for (let i = baseIdx - 1; i >= 0; i--) {
		const neighborId = identityOf(baseArr[i], seg);
		const seqIdx = neighborId === undefined ? -1 : sequence.indexOf(neighborId);
		if (seqIdx !== -1) return seqIdx + 1;
	}
	return 0;
}
