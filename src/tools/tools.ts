import type { Engine } from '../engine.js';
import type { CopilotSession } from '../copilot.js';

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type EditTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => ToolResult;
};

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data) };
}

function err(message: string): ToolResult {
  return { content: message, isError: true };
}

function requireSession(engine: Engine): CopilotSession {
  const session = engine.activeCopilotSession();
  if (!session) throw new Error('No active copilot session. Call start_session first.');
  return session;
}

export function createEditTools(engine: Engine): EditTool[] {
  return [
    {
      name: 'start_session',
      description:
        'Start a copilot editing session. You must call this before proposing changes. ' +
        'Only one session can be active at a time. The user will review your proposals ' +
        'and approve or decline them individually.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          engine.startCopilot();
          return ok({ status: 'started' });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'end_session',
      description:
        'End the current copilot session. Any proposals that have not been ' +
        'approved or declined by the user will be discarded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          requireSession(engine).end();
          return ok({ status: 'ended' });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'propose',
      description:
        'Propose a change to the JSON document. The change is held for user review — ' +
        'it will not take effect until the user approves it.\n\n' +
        'kind: "add" (create a new field), "remove" (delete a field), or "replace" (change a value).\n' +
        'path: A JSON Pointer (RFC 6901), e.g. "/server/port" or "/items/0".\n' +
        'value: The new value (required for add and replace, omit for remove).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON Pointer (RFC 6901) to the target field' },
          kind: { type: 'string', enum: ['add', 'remove', 'replace'], description: 'The type of change' },
          value: { description: 'The new value (required for add/replace, omit for remove)' },
        },
        required: ['path', 'kind'],
        additionalProperties: false,
      },
      handler: (input) => {
        try {
          const session = requireSession(engine);
          session.propose({
            path: input.path as string,
            kind: input.kind as 'add' | 'remove' | 'replace',
            value: input.value,
          });
          return ok({ status: 'proposed', path: input.path });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'move',
      description:
        'Move or rename a field in the JSON document. The value at the source path is ' +
        'moved to the destination path. This is one undoable action.\n\n' +
        'Use this for renaming keys (e.g. from "/host" to "/hostname") or relocating ' +
        'values (e.g. from "/server/host" to "/config/host").',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'JSON Pointer to the source field' },
          to: { type: 'string', description: 'JSON Pointer to the destination field' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      handler: (input) => {
        try {
          const session = requireSession(engine);
          session.move(input.from as string, input.to as string);
          return ok({ status: 'moved', from: input.from, to: input.to });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'get_value',
      description:
        'Read the current value at a path in the document. Returns the effective value ' +
        '(base + user edits + copilot proposals). Use an empty string "" for the root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON Pointer to read (use "" for root)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: (input) => {
        try {
          const value = engine.get(input.path as string);
          return ok({ value });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'get_diff',
      description:
        'Get the list of pending copilot proposals. Each entry shows the path, kind, ' +
        'previous value, proposed value, and whether it conflicts with a user edit.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          const session = requireSession(engine);
          const ops = session.diff().map(({ path, kind, value, prev, conflictsWithUser }) => ({
            path, kind, value, prev, conflictsWithUser,
          }));
          return ok({ ops });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'approve',
      description:
        'Approve a single copilot proposal, folding it into the user\'s edit history. ' +
        'The path must match a pending proposal exactly.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON Pointer of the proposal to approve' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: (input) => {
        try {
          requireSession(engine).approve(input.path as string);
          return ok({ status: 'approved', path: input.path });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'decline',
      description:
        'Decline a single copilot proposal, discarding it. ' +
        'The path must match a pending proposal exactly.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON Pointer of the proposal to decline' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: (input) => {
        try {
          requireSession(engine).decline(input.path as string);
          return ok({ status: 'declined', path: input.path });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'approve_all',
      description:
        'Approve all pending copilot proposals and close the session. ' +
        'All proposals are folded into the user\'s edit history.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          requireSession(engine).approveAll();
          return ok({ status: 'approved_all' });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'decline_all',
      description:
        'Decline all pending copilot proposals and close the session. ' +
        'All proposals are discarded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          requireSession(engine).declineAll();
          return ok({ status: 'declined_all' });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },

    {
      name: 'export',
      description:
        'Export the full current state of the document as JSON. ' +
        'This includes the base, all user edits, and all approved copilot proposals.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        try {
          return ok({ document: engine.export() });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    },
  ];
}
