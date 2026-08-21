import type { DiffOp } from './engine.js';
import { sortDiff } from './engine.js';

// Order-independent structural equality for two DiffOp[] — the same
// normalization sortDiff() gives snapshots, usable directly as a boolean
// check. diff()'s array order follows the source objects' own key-insertion
// order (see engine.ts's diffNode), so a plain `toEqual` on two otherwise-
// identical diffs can fail on order alone.
export function diffsEqual(actual: DiffOp[], expected: DiffOp[]): boolean {
	return JSON.stringify(sortDiff(actual)) === JSON.stringify(sortDiff(expected));
}

interface MatcherResult {
	pass: boolean;
	message: () => string;
}

function formatOps(ops: DiffOp[]): string {
	return JSON.stringify(sortDiff(ops), null, 2);
}

// True if some op in `ops` matches every field given in `pattern` — the
// pattern's fields are the only ones compared, so `{ op: 'remove', identity: 5 }`
// matches regardless of what `path`/`value` happen to be. This is what a full
// DiffOp equality check can't do: assert that one specific thing changed
// without pinning down everything else in the diff.
export function diffContainsOp(ops: DiffOp[], pattern: Partial<DiffOp>): boolean {
	return ops.some(op =>
		(Object.keys(pattern) as Array<keyof DiffOp>).every(
			key => JSON.stringify((op as any)[key]) === JSON.stringify(pattern[key]),
		),
	);
}

// A custom matcher for vitest's `expect.extend` / Jest's `expect.extend` —
// both implement the same `{ pass, message }` contract, so this object works
// unmodified with either.
//
//   import { patchworkMatchers } from '@maxjay/patchwork/testing';
//   expect.extend(patchworkMatchers); // once, in a setup file
//
//   expect(engine.diff()).toEqualDiff([
//     { op: 'replace', path: "$['x']", oldValue: 1, value: 2 },
//   ]);
//
// Order-independent by construction — there's no second sortDiff() call to
// forget on either side, and a mismatch prints both sides pre-sorted so the
// failure message shows the actual structural difference instead of a
// reordered-array diff that obscures it.
export const patchworkMatchers = {
	toEqualDiff(received: DiffOp[], expected: DiffOp[]): MatcherResult {
		const pass = diffsEqual(received, expected);
		return {
			pass,
			message: () =>
				pass
					? `expected diff not to equal:\n${formatOps(expected)}`
					: `diff did not match (compared order-independently):\n\n` +
						`received:\n${formatOps(received)}\n\n` +
						`expected:\n${formatOps(expected)}`,
		};
	},

	// For "did this one thing happen" without enumerating the whole diff —
	// the partial-op counterpart to toEqualDiff's full-list comparison.
	//
	//   expect(engine.diff()).toContainDiffOp({ op: 'remove', identity: 5 });
	//
	// Only the fields present in the pattern are compared; anything else on
	// the matched op (path, value, oldValue, ...) is ignored.
	toContainDiffOp(received: DiffOp[], pattern: Partial<DiffOp>): MatcherResult {
		const pass = diffContainsOp(received, pattern);
		return {
			pass,
			message: () =>
				pass
					? `expected diff not to contain an op matching:\n${JSON.stringify(pattern, null, 2)}`
					: `expected diff to contain an op matching:\n${JSON.stringify(pattern, null, 2)}\n\n` +
						`received:\n${formatOps(received)}`,
		};
	},
};
