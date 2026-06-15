import { describe, it, expect } from 'vitest';
import { Engine, OpType } from './engine';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function makeSchema(key: string, ordered = false) {
	return {
		type: 'object' as const,
		properties: {
			items: {
				type: 'array' as const,
				'x-key': key,
				...(ordered && { 'x-ordered': true }),
				items: { type: 'object' as const },
			},
		},
	};
}

function makeNestedSchema(parentKey: string, childKey: string) {
	return {
		type: 'object' as const,
		properties: {
			items: {
				type: 'array' as const,
				'x-key': parentKey,
				items: {
					type: 'object' as const,
					properties: {
						children: {
							type: 'array' as const,
							'x-key': childKey,
							items: { type: 'object' as const },
						},
					},
				},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Identity matching
// ---------------------------------------------------------------------------

describe('x-key identity matching', () => {
	it('remove by identity produces one remove op, not a cascade of replaces', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }] },
			{ schema: makeSchema('id') },
		);
		e.delete('$.items[0]');
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Remove, identity: 1 });
	});

	it('add by identity produces one add op', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }] },
			{ schema: makeSchema('id') },
		);
		e.add('$.items[1]', { id: 2, name: 'B' });
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Add, identity: 2, value: { id: 2, name: 'B' } });
	});

	it('field change produces a replace op with identity and changes', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha', age: 30 }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].age', 31);
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			op:       OpType.Replace,
			identity: 1,
			changes:  [{ op: OpType.Replace, path: "$['items'][0]['age']", oldValue: 30, value: 31 }],
		});
	});

	it('unchanged element does not appear in default diff', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'A modified');
		const ops = e.diff();
		expect(ops.every(op => (op as any).identity !== 2)).toBe(true);
	});

	it('multiple field changes on same element are grouped into one replace op', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha', age: 30 }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'Beta');
		e.replace('$.items[0].age', 31);
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Replace, identity: 1 });
		expect((ops[0] as any).changes).toHaveLength(2);
	});

	it('changes paths are absolute document paths', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'Beta');
		const ops = e.diff();
		const change = (ops[0] as any).changes[0];
		expect(change.path).toBe("$['items'][0]['name']");
	});
});

// ---------------------------------------------------------------------------
// 2. Ordered arrays — displacement
// ---------------------------------------------------------------------------

describe('ordered arrays — displacement', () => {
	it('remove produces a move op for each displaced element', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: makeSchema('id', true) },
		);
		e.delete('$.items[0]');
		const ops = e.diff();
		const removeOp = ops.find(op => op.op === OpType.Remove);
		const moveOp   = ops.find(op => op.op === OpType.Move && (op as any).identity === 'B');
		const moveOp2  = ops.find(op => op.op === OpType.Move && (op as any).identity === 'C');
		expect(removeOp).toMatchObject({ op: OpType.Remove, identity: 'A' });
		expect(moveOp).toMatchObject({ op: OpType.Move, identity: 'B' });
		expect(moveOp2).toMatchObject({ op: OpType.Move, identity: 'C' });
	});

	it('move op carries from (base path) and to (draft path)', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: makeSchema('id', true) },
		);
		e.delete('$.items[0]');
		const ops  = e.diff();
		const move = ops.find(op => op.op === OpType.Move && (op as any).identity === 'B') as any;
		expect(move.from).toBe("$['items'][1]");
		expect(move.to).toBe("$['items'][0]");
	});

	it('add produces move ops for elements pushed down', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }] },
			{ schema: makeSchema('id', true) },
		);
		e.add('$.items[0]', { id: 'X' });
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Add && (op as any).identity === 'X')).toBe(true);
		expect(ops.some(op => op.op === OpType.Move && (op as any).identity === 'A')).toBe(true);
		expect(ops.some(op => op.op === OpType.Move && (op as any).identity === 'B')).toBe(true);
	});

	it('remove + add at same position produces zero net displacement', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: makeSchema('id', true) },
		);
		e.delete('$.items[1]');
		e.add('$.items[1]', { id: 'X' });
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Remove && (op as any).identity === 'B')).toBe(true);
		expect(ops.some(op => op.op === OpType.Add    && (op as any).identity === 'X')).toBe(true);
		expect(ops.some(op => op.op === OpType.Move   && (op as any).identity === 'C')).toBe(false);
	});

	it('two adds before an element produce displacement move for that element', () => {
		const e = new Engine(
			{ items: [{ id: 'C' }] },
			{ schema: makeSchema('id', true) },
		);
		e.add('$.items[0]', { id: 'A' });
		e.add('$.items[0]', { id: 'B' });
		const ops  = e.diff();
		const move = ops.find(op => op.op === OpType.Move && (op as any).identity === 'C') as any;
		expect(move).toBeDefined();
		expect(move.to).toBe("$['items'][2]");
		expect(move.from).toBe("$['items'][0]");
	});

	it('element with field change and position change produces replace with non-zero displacement', () => {
		const e = new Engine(
			{ items: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] },
			{ schema: makeSchema('id', true) },
		);
		e.add('$.items[0]', { id: 'X' });
		e.replace('$.items[1].name', 'Alpha modified');
		const ops = e.diff();
		const replaceOp = ops.find(op => op.op === OpType.Replace && (op as any).identity === 'A') as any;
		expect(replaceOp).toBeDefined();
		expect(replaceOp.displacement).not.toBe(0);
		expect(replaceOp.changes).toHaveLength(1);
	});

	it('unordered array: remove does not displace other elements', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: makeSchema('id', false) },
		);
		e.delete('$.items[0]');
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Remove, identity: 'A' });
		expect(ops.some(op => op.op === OpType.Move)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. includeUnchanged
// ---------------------------------------------------------------------------

describe('diff — includeUnchanged option', () => {
	it('default diff excludes unchanged elements', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'A modified');
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Unchanged)).toBe(false);
	});

	it('includeUnchanged: true adds unchanged ops for unmodified elements', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'A modified');
		const ops = e.diff(undefined, { includeUnchanged: true });
		const unchangedOp = ops.find(op => op.op === OpType.Unchanged && (op as any).identity === 2);
		expect(unchangedOp).toBeDefined();
		expect((unchangedOp as any).displacement).toBe(0);
	});

	it('displaced element appears as move op in both default and includeUnchanged modes', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }] },
			{ schema: makeSchema('id', true) },
		);
		e.delete('$.items[0]');
		const defaultOps = e.diff();
		const allOps     = e.diff(undefined, { includeUnchanged: true });
		expect(defaultOps.some(op => op.op === OpType.Move && (op as any).identity === 'B')).toBe(true);
		expect(allOps.some(op => op.op === OpType.Move     && (op as any).identity === 'B')).toBe(true);
		expect(allOps.some(op => op.op === OpType.Unchanged && (op as any).identity === 'B')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. cascade
// ---------------------------------------------------------------------------

describe('diff — cascade option', () => {
	it('cascade: true (default) — nested identity change marks parent as modified', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Parent', children: [{ id: 'c1', age: 5 }] }] },
			{ schema: makeNestedSchema('id', 'id') },
		);
		e.replace('$.items[0].children[0].age', 6);
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Replace && (op as any).identity === 1)).toBe(true);
	});

	it('cascade: false — nested identity change does not mark parent as modified', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Parent', children: [{ id: 'c1', age: 5 }] }] },
			{ schema: makeNestedSchema('id', 'id') },
		);
		e.replace('$.items[0].children[0].age', 6);
		const ops = e.diff(undefined, { cascade: false });
		expect(ops.some(op => (op as any).identity === 1)).toBe(false);
	});

	it('cascade: false — parent with direct field change is still modified', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Parent', children: [{ id: 'c1', age: 5 }] }] },
			{ schema: makeNestedSchema('id', 'id') },
		);
		e.replace('$.items[0].name', 'Parent modified');
		e.replace('$.items[0].children[0].age', 6);
		const ops = e.diff(undefined, { cascade: false });
		const replaceOp = ops.find(op => op.op === OpType.Replace && (op as any).identity === 1) as any;
		expect(replaceOp).toBeDefined();
		expect(replaceOp.changes.every((c: any) => c.path === "$['items'][0]['name']")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. $self arrays
// ---------------------------------------------------------------------------

describe('$self identity', () => {
	const selfSchema = {
		type: 'object' as const,
		properties: {
			tags: {
				type: 'array' as const,
				'x-key': '$self',
				items: { type: 'string' as const },
			},
		},
	};

	it('remove primitive produces one remove op, identity is the value', () => {
		const e = new Engine({ tags: ['a', 'b', 'c'] }, { schema: selfSchema });
		e.delete('$.tags[1]');
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Remove, identity: 'b', value: 'b' });
	});

	it('add primitive produces one add op, identity is the value', () => {
		const e = new Engine({ tags: ['a', 'b'] }, { schema: selfSchema });
		e.add('$.tags[2]', 'c');
		const ops = e.diff();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Add, identity: 'c', value: 'c' });
	});

	it('reorder in unordered $self array produces no ops', () => {
		const e = new Engine({ tags: ['a', 'b', 'c'] }, { schema: selfSchema });
		e.delete('$.tags[0]');
		e.add('$.tags[2]', 'a');
		const ops = e.diff();
		expect(ops).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 6. restore
// ---------------------------------------------------------------------------

describe('Engine.restore', () => {
	it('restore of add op removes the element from draft', () => {
		const e = new Engine(
			{ items: [{ id: 1 }] },
			{ schema: makeSchema('id') },
		);
		e.add('$.items[1]', { id: 2 });
		const [addOp] = e.diff();
		e.restore(addOp);
		expect(e.draft).toEqual({ items: [{ id: 1 }] });
	});

	it('restore of remove op reinserts the element at the correct position', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
			{ schema: makeSchema('id') },
		);
		e.delete('$.items[0]');
		const [removeOp] = e.diff();
		e.restore(removeOp);
		expect(e.draft).toEqual({ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
	});

	it('restore of replace op reverts the field to its old value', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'Beta');
		const [replaceOp] = e.diff();
		e.restore(replaceOp);
		expect(e.draft).toEqual({ items: [{ id: 1, name: 'Alpha' }] });
	});

	it('restore of move op (displacement) moves element back to base position', () => {
		const e = new Engine(
			{ items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
			{ schema: makeSchema('id', true) },
		);
		e.delete('$.items[0]');
		const moveOp = e.diff().find(op => op.op === OpType.Move && (op as any).identity === 'B')!;
		e.restore(moveOp);
		expect(e.draft.items[1]).toMatchObject({ id: 'B' });
	});

	it('restore is pushed onto the undo stack and can itself be undone', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].name', 'Beta');
		const [replaceOp] = e.diff();
		e.restore(replaceOp);
		expect(e.draft.items[0].name).toBe('Alpha');
		e.undo();
		expect(e.draft.items[0].name).toBe('Beta');
	});

	it('restore of modified + displaced restores fields and position', () => {
		const e = new Engine(
			{ items: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] },
			{ schema: makeSchema('id', true) },
		);
		e.add('$.items[0]', { id: 'X' });
		e.replace('$.items[1].name', 'Alpha modified');
		const replaceOp = e.diff().find(op => op.op === OpType.Replace && (op as any).identity === 'A')!;
		e.restore(replaceOp);
		expect((e.draft as any).items.find((i: any) => i.id === 'A').name).toBe('Alpha');
		expect((e.draft as any).items.findIndex((i: any) => i.id === 'A')).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 7. Identity stability
// ---------------------------------------------------------------------------

describe('identity stability', () => {
	it('mutating the x-key field appears as remove + add, not modify', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'Alpha' }] },
			{ schema: makeSchema('id') },
		);
		e.replace('$.items[0].id', 99);
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Remove && (op as any).identity === 1)).toBe(true);
		expect(ops.some(op => op.op === OpType.Add    && (op as any).identity === 99)).toBe(true);
		expect(ops.some(op => op.op === OpType.Replace)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 8. Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	it('empty base array with adds produces only add ops', () => {
		const e = new Engine({ items: [] as any[] }, { schema: makeSchema('id') });
		e.add('$.items[0]', { id: 1, name: 'A' });
		e.add('$.items[1]', { id: 2, name: 'B' });
		const ops = e.diff();
		expect(ops).toHaveLength(2);
		expect(ops.every(op => op.op === OpType.Add)).toBe(true);
	});

	it('all elements removed produces only remove ops', () => {
		const e = new Engine(
			{ items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
			{ schema: makeSchema('id') },
		);
		e.delete('$.items[2]');
		e.delete('$.items[1]');
		e.delete('$.items[0]');
		const ops = e.diff();
		expect(ops).toHaveLength(3);
		expect(ops.every(op => op.op === OpType.Remove)).toBe(true);
	});

	it('no changes produces empty diff', () => {
		const e = new Engine(
			{ items: [{ id: 1, name: 'A' }] },
			{ schema: makeSchema('id') },
		);
		expect(e.diff()).toHaveLength(0);
	});

	it('multiple independent keyed arrays in same document are each diffed independently', () => {
		const e = new Engine(
			{
				users:   [{ id: 1, name: 'Alice' }],
				regions: [{ code: 'us', label: 'US East' }],
			},
			{
				schema: {
					type: 'object',
					properties: {
						users:   { type: 'array', 'x-key': 'id',   items: { type: 'object' } },
						regions: { type: 'array', 'x-key': 'code', items: { type: 'object' } },
					},
				},
			},
		);
		e.replace('$.users[0].name', 'Bob');
		e.delete('$.regions[0]');
		const ops = e.diff();
		expect(ops.some(op => op.op === OpType.Replace && (op as any).identity === 1)).toBe(true);
		expect(ops.some(op => op.op === OpType.Remove  && (op as any).identity === 'us')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// diff — includeUnchanged propagation into nested keyed arrays
//
// Schema anatomy: orders (keyed by ref) → each order has lineItems (keyed by sku).
// When diff() is called with includeUnchanged: true for a specific lineItems path,
// it should return Unchanged ops for every unmodified line item.
// Bug: diffArrayByKey hard-coded includeUnchanged: false when recursing into
// matched element pairs, so nested Unchanged ops were never emitted.
// ---------------------------------------------------------------------------

const ordersSchema = makeNestedSchema('ref', 'sku');

// Convenience: build an engine with one order that has three line items.
function makeOrdersEngine() {
	return new Engine<any>(
		{
			items: [
				{
					ref: 'ORD-1',
					label: 'First order',
					children: [
						{ sku: 'ALPHA', qty: 1 },
						{ sku: 'BETA',  qty: 2 },
						{ sku: 'GAMMA', qty: 5 },
					],
				},
				{
					ref: 'ORD-2',
					label: 'Second order',
					children: [
						{ sku: 'DELTA', qty: 3 },
					],
				},
			],
		},
		{ schema: ordersSchema },
	);
}

describe('diff — includeUnchanged propagation into nested keyed arrays', () => {
	it('no changes: diff on child path with includeUnchanged returns Unchanged for every child', () => {
		const e = makeOrdersEngine();
		const ops = e.diff("$.items[0].children", { includeUnchanged: true });
		expect(ops).toHaveLength(3);
		expect(ops.every(o => o.op === OpType.Unchanged)).toBe(true);
		expect(ops.map((o: any) => o.identity).sort()).toEqual(['ALPHA', 'BETA', 'GAMMA']);
	});

	it('one child removed: diff returns Remove + Unchanged for remaining children', () => {
		const e = makeOrdersEngine();
		e.delete('$.items[0].children[0]'); // remove ALPHA
		const ops = e.diff("$.items[0].children", { includeUnchanged: true });
		expect(ops.some(o => o.op === OpType.Remove    && (o as any).identity === 'ALPHA')).toBe(true);
		expect(ops.some(o => o.op === OpType.Unchanged && (o as any).identity === 'BETA')).toBe(true);
		expect(ops.some(o => o.op === OpType.Unchanged && (o as any).identity === 'GAMMA')).toBe(true);
		expect(ops).toHaveLength(3);
	});

	it('one child added: diff returns Add + Unchanged for existing children', () => {
		const e = makeOrdersEngine();
		e.add('$.items[0].children[3]', { sku: 'DELTA-NEW', qty: 9 });
		const ops = e.diff("$.items[0].children", { includeUnchanged: true });
		expect(ops.some(o => o.op === OpType.Add       && (o as any).identity === 'DELTA-NEW')).toBe(true);
		expect(ops.some(o => o.op === OpType.Unchanged && (o as any).identity === 'ALPHA')).toBe(true);
		expect(ops.some(o => o.op === OpType.Unchanged && (o as any).identity === 'BETA')).toBe(true);
		expect(ops.some(o => o.op === OpType.Unchanged && (o as any).identity === 'GAMMA')).toBe(true);
	});

	it('parent field changed (not the child array): child diff still returns Unchanged for children', () => {
		const e = makeOrdersEngine();
		e.replace('$.items[0].label', 'Updated label'); // change parent, not children
		const ops = e.diff("$.items[0].children", { includeUnchanged: true });
		expect(ops).toHaveLength(3);
		expect(ops.every(o => o.op === OpType.Unchanged)).toBe(true);
	});

	it('second order children are unaffected when only first order changes', () => {
		const e = makeOrdersEngine();
		e.delete('$.items[0].children[0]'); // mutate ORD-1 only
		const ops = e.diff("$.items[1].children", { includeUnchanged: true });
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: OpType.Unchanged, identity: 'DELTA' });
	});

	it('field change on one child: returns one Replace op for that child — not a duplicate field-level op', () => {
		const e = makeOrdersEngine();
		e.replace('$.items[0].children[1].qty', 99); // change BETA's qty
		const ops = e.diff("$.items[0].children", { includeUnchanged: true });
		// Expect exactly one op per child — no field-level replace leaking out alongside the element Replace
		expect(ops).toHaveLength(3);
		const betaOp = ops.find((o: any) => o.identity === 'BETA');
		expect(betaOp).toBeDefined();
		expect(betaOp!.op).toBe(OpType.Replace);
		expect((betaOp as any).changes).toHaveLength(1); // field-level replace lives inside .changes
		expect(ops.filter(o => o.op === OpType.Replace)).toHaveLength(1); // not duplicated at top level
	});
});
