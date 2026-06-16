import { describe, it, expect } from 'vitest';
import { Engine, OpType } from './engine';

const INITIAL = {
  regions: [
    {
      code: 'EU',
      name: 'Europe',
      districts: [
        { id: 'eu-north', label: 'Northern Europe',  population: 105 },
        { id: 'eu-west',  label: 'Western Europe',   population: 198 },
        { id: 'eu-east',  label: 'Eastern Europe',   population: 292 },
        { id: 'eu-south', label: 'Southern Europe',  population: 151 },
        { id: 'eu-cent',  label: 'Central Europe',   population: 134 },
      ],
    },
  ],
};

const SCHEMA = {
  properties: {
    regions: {
      'x-key': 'code',
      items: {
        properties: {
          districts: {
            'x-key': 'id',
            items: { properties: {} },
          },
        },
      },
    },
  },
};

describe('restore removed item in keyed array after multiple deletes', () => {
  it('restores Southern Europe after Western, Eastern, Southern, Central all deleted', () => {
    const e = new Engine(INITIAL, { schema: SCHEMA });

    // delete Western, Eastern, Southern, Central (always delete index 1 as items shift down)
    e.delete("$['regions'][0]['districts'][1]");
    e.delete("$['regions'][0]['districts'][1]");
    e.delete("$['regions'][0]['districts'][1]");
    e.delete("$['regions'][0]['districts'][1]");

    // draft is now [Northern Europe] only
    expect((e.draft as any).regions[0].districts).toHaveLength(1);

    // find the Remove op for Southern Europe — nested in the Replace op's changes for EU
    const ops = e.diff();
    const euOp = ops.find(op => op.op === OpType.Replace && (op as any).identity === 'EU');
    const southernOp = (euOp as any)?.changes?.find((op: any) => op.op === OpType.Remove && op.identity === 'eu-south');
    expect(southernOp).toBeDefined();

    // restore it — should splice in, not setAt index 3 on a 1-item array
    e.restore(southernOp!);

    const districts = (e.draft as any).regions[0].districts;

    // no sparse holes — Southern Europe appended after Northern Europe
    expect(districts).toHaveLength(2);
    expect(districts[0].id).toBe('eu-north');
    expect(districts[1].id).toBe('eu-south');

    // diff must not throw
    expect(() => e.diff()).not.toThrow();
  });
});
