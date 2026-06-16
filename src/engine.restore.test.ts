import { describe, it, expect } from 'vitest';
import { Engine, OpType } from './engine';

const INITIAL = {
  primaryTaskTypes: [
    {
      taskMnemonic: 'DEV',
      description: 'Development Task',
      action: 'develop',
      secondaryTaskTypes: [
        { description: 'Frontend Work',      taskMnemonic: 'DEV-FE',  pttTaskMnemonic: 'DEV', action: 'build-ui' },
        { description: 'Backend Work',       taskMnemonic: 'DEV-BE',  pttTaskMnemonic: 'DEV', action: 'build-api' },
        { description: 'Database Migration', taskMnemonic: 'DEV-DB',  pttTaskMnemonic: 'DEV', action: 'migrate' },
        { description: 'Code Review',        taskMnemonic: 'DEV-CR',  pttTaskMnemonic: 'DEV', action: 'review' },
        { description: 'Testing',            taskMnemonic: 'DEV-TST', pttTaskMnemonic: 'DEV', action: 'test' },
      ],
    },
  ],
};

const SCHEMA = {
  properties: {
    primaryTaskTypes: {
      'x-key': 'taskMnemonic',
      items: {
        properties: {
          secondaryTaskTypes: {
            'x-key': 'description',
            items: { properties: {} },
          },
        },
      },
    },
  },
};

describe('restore removed item in keyed array after multiple deletes', () => {
  it('restores Code Review after Backend, Database, Code Review, Testing all deleted', () => {
    const e = new Engine(INITIAL, { schema: SCHEMA });

    // delete Backend Work, Database Migration, Code Review, Testing (always delete index 1 as they shift down)
    e.delete("$['primaryTaskTypes'][0]['secondaryTaskTypes'][1]");
    e.delete("$['primaryTaskTypes'][0]['secondaryTaskTypes'][1]");
    e.delete("$['primaryTaskTypes'][0]['secondaryTaskTypes'][1]");
    e.delete("$['primaryTaskTypes'][0]['secondaryTaskTypes'][1]");

    // draft is now [Frontend Work] only
    expect((e.draft as any).primaryTaskTypes[0].secondaryTaskTypes).toHaveLength(1);

    // find the Remove op for Code Review — it's nested in the Replace op's changes for DEV
    const ops = e.diff();
    const devOp = ops.find(op => op.op === OpType.Replace && (op as any).identity === 'DEV');
    const reviewOp = (devOp as any)?.changes?.find((op: any) => op.op === OpType.Remove && op.identity === 'Code Review');
    expect(reviewOp).toBeDefined();

    // restore it — should splice in, not setAt index 3 on a 1-item array
    e.restore(reviewOp!);

    const stts = (e.draft as any).primaryTaskTypes[0].secondaryTaskTypes;

    // no sparse holes — Code Review appended after Frontend Work
    expect(stts).toHaveLength(2);
    expect(stts[0].description).toBe('Frontend Work');
    expect(stts[1].description).toBe('Code Review');

    // diff must not throw
    expect(() => e.diff()).not.toThrow();
  });
});
