# LLM integration

Patchwork is designed from the ground up for agentic use — an LLM writes to a draft, a human reviews and commits. This document covers the full integration surface: tool creation, scoping, streaming, adapters, MCP, and ready-to-use wiring for Anthropic and OpenAI.

---

## The design principle

The base/draft split maps directly onto the human-in-the-loop pattern:

- **LLM** — calls tools to read and mutate `draft`. It has no access to `accept`, `decline`, `undo`, or `redo`.
- **Human** — inspects `diff()`, decides whether to accept or decline, and controls history.

The LLM is a powerful editor. The human is the gatekeeper. This boundary is enforced by construction — the tool set simply does not include the committing operations.

---

## `createEngineTools`

```ts
import { createEngineTools } from '@maxjay/patchwork/tools';

const tools = createEngineTools(engine);
```

Returns 9 `Tool` objects:

| Tool | What it does |
|---|---|
| `add` | Add a value at a JSONPath. Splices into arrays, sets on objects, creates missing intermediates. |
| `replace` | Replace the value(s) at a JSONPath. Wildcards replace all matches. |
| `delete` | Remove at a JSONPath. Splices arrays in place. |
| `move` | Move a value from one path to another. |
| `copy` | Copy a value from one path to another. |
| `revert` | Reset draft at a JSONPath back to whatever base has there. |
| `get` | Query draft for all values matching a JSONPath. Returns `[{path, value}]`. |
| `getValue` | Strict single-match read. Throws on multi-match or no match. |
| `diff` | Return structural differences between base and draft. |

The `Tool` interface is framework-neutral:

```ts
interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: object;    // JSON Schema
  execute(input: TInput): TOutput;
}
```

Wrap this shape for whichever SDK you're using. Adapters for Anthropic, OpenAI, and MCP are covered below.

### Why `accept`/`decline`/`undo`/`redo` are excluded

These operations affect the committed state or the history of how edits were made — decisions that belong to the human, not the model. An LLM with `accept` can silently commit unreviewed changes; an LLM with `undo` can erase changes made by the human. Neither is the intended relationship.

If you want the model to request a commit (e.g., "I'm done, please review"), implement that as a signal in your application layer, not as a tool.

---

## Scoping with `NodeEngine`

Pass a `NodeEngine` to `createEngineTools` to limit the model's reach to a subtree.

```ts
const engine = new Engine(fullDocument);
const scoped = engine.getNodeEngine('$.userSettings');
const tools = createEngineTools(scoped);
```

The model can read and edit `userSettings` freely. It cannot see or touch anything outside that subtree — the tool implementations simply never receive or produce paths outside the prefix. This is structural isolation, not a runtime check.

Multiple agents can each get a scoped lens on a different subtree, sharing the same document with no risk of cross-contamination. Both sets of changes land on the same parent undo stack, so a human can undo any of them.

---

## Ephemeral tools for streaming

Add `beginEphemeral` and `commitEphemeral` to the tool set when the model will stream output:

```ts
const tools = createEngineTools(engine, { includeEphemeral: true });
// 11 tools: the base 9 + beginEphemeral, commitEphemeral
```

The intended flow:

1. Model calls `beginEphemeral`.
2. Model calls `replace` on each chunk as it arrives. The draft updates live — your UI can render it immediately.
3. Model calls `commitEphemeral` when the stream ends.

The user sees real-time output, but the entire stream collapses into a single undo entry. One undo step snaps back to the state before the stream started.

`discardEphemeral` is not exposed. Cancelling a preview or a streaming operation is a human decision — they press a cancel button, your application calls `engine.discardEphemeral()` directly.

---

## `runAgentLoop`

```ts
import { runAgentLoop } from '@maxjay/patchwork/chat';
```

A minimal agentic loop that handles the tool call / result cycle. Takes a message history, a set of tools, and an adapter, and runs until the model produces a reply without tool calls (or hits `maxIterations`).

```ts
const { reply, newMessages } = await runAgentLoop(
  tools,
  messages,
  adapter,
  { maxIterations: 20 },
);
```

- **`tools`** — the `Tool[]` from `createEngineTools`.
- **`messages`** — `AgentMessage[]`. Your conversation history.
- **`adapter`** — either a `NativeAdapter` (model natively supports tool use) or a `PromptAdapter` (tool calls injected into text via XML tags).
- **`newMessages`** — the messages appended during this loop invocation (assistant turns and tool results). Append these to your history for the next turn.

### `NativeAdapter`

For models with first-class tool use (Anthropic, OpenAI, etc.):

```ts
const adapter: NativeAdapter = {
  mode: 'native',
  call: async (messages, tools) => {
    // translate messages and tools into SDK format, call API, return normalized result
    return { text: '...', toolCalls: [{ id, name, input }] };
  },
};
```

The loop passes `AgentMessage[]` and `AgentTool[]` to your `call` function and expects back a `{ text?, toolCalls? }` object. You translate in and out of your SDK's format.

### `PromptAdapter`

For models without native tool support (or when you want full control over the prompt):

```ts
const adapter: PromptAdapter = {
  mode: 'prompt',
  call: async (messages) => {
    // flatten and call, return { text }
    return { text: '...' };
  },
};
```

The loop injects tool definitions into the system prompt and parses `<tool_call>{"name":"...","input":{...}}</tool_call>` XML blocks from the model's text response. Tool results are appended as user messages. This works with any text-completion model.

---

## Adapters in practice

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createEngineTools, toAgentTools } from '@maxjay/patchwork/tools';
import { runAgentLoop, type NativeAdapter } from '@maxjay/patchwork/chat';

const client = new Anthropic();
const tools = createEngineTools(engine);

const adapter: NativeAdapter = {
  mode: 'native',
  call: async (messages, agentTools) => {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      tools: agentTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => {
          if (m.role === 'tool') {
            return {
              role: 'user' as const,
              content: [{ type: 'tool_result' as const, tool_use_id: m.toolCallId!, content: JSON.stringify(m.toolResult) }],
            };
          }
          if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
              role: 'assistant' as const,
              content: [
                ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
                ...m.toolCalls.map(tc => ({ type: 'tool_use' as const, id: tc.id, name: tc.name, input: tc.input })),
              ],
            };
          }
          return { role: m.role as 'user' | 'assistant', content: m.content ?? '' };
        }),
      system: messages.find(m => m.role === 'system')?.content,
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    const toolCalls = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: (b as any).id, name: (b as any).name, input: (b as any).input }));

    return { text, toolCalls };
  },
};

const { reply } = await runAgentLoop(tools, [
  { role: 'system', content: 'You are a config editor. Edit the draft as requested.' },
  { role: 'user',   content: 'Set the server port to 443 and enable SSL.' },
], adapter);
```

### OpenAI

```ts
import OpenAI from 'openai';
import { createEngineTools } from '@maxjay/patchwork/tools';
import { runAgentLoop, type NativeAdapter } from '@maxjay/patchwork/chat';

const client = new OpenAI();
const tools = createEngineTools(engine);

const adapter: NativeAdapter = {
  mode: 'native',
  call: async (messages, agentTools) => {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      tools: agentTools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, tool_call_id: m.toolCallId!, content: JSON.stringify(m.toolResult) };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant' as const,
            content: m.content ?? null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          };
        }
        return { role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' };
      }),
    });

    const msg = response.choices[0].message;
    const text = msg.content ?? undefined;
    const toolCalls = msg.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    return { text, toolCalls };
  },
};
```

---

## MCP integration

```ts
import { toMcpTools, handleMcpCall } from '@maxjay/patchwork/mcp';
import { createEngineTools } from '@maxjay/patchwork/tools';

const engineTools = createEngineTools(engine);
const mcpTools = toMcpTools(engineTools);
// mcpTools: Array<{ name, description, inputSchema }>
// — the exact shape an MCP server's ListTools response expects
```

In your MCP server's `CallTool` handler:

```ts
const result = handleMcpCall(engineTools, toolName, toolInput);
// result: { content: [{ type: 'text', text: string }], isError?: boolean }
// — the exact shape an MCP CallTool response expects
```

`handleMcpCall` catches errors thrown by `execute` and returns them as `isError: true` responses rather than letting them propagate — MCP servers should not throw on tool errors.

### Minimal MCP server example

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Engine } from '@maxjay/patchwork';
import { createEngineTools } from '@maxjay/patchwork/tools';
import { toMcpTools, handleMcpCall } from '@maxjay/patchwork/mcp';

const engine = new Engine(yourDocument);
const engineTools = createEngineTools(engine);
const mcpTools = toMcpTools(engineTools);

const server = new Server({ name: 'patchwork', version: '1.0.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler('tools/list', async () => ({ tools: mcpTools }));

server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: args } = req.params;
  return handleMcpCall(engineTools, name, args as Record<string, unknown>);
});

await server.connect(new StdioServerTransport());
```

---

## Patterns

### Multiple agents, one document

Give each agent a scoped lens on a different subtree. They share the document but can't interfere:

```ts
const doc = new Engine(fullConfig);

const agentA = createEngineTools(doc.getNodeEngine('$.networkConfig'));
const agentB = createEngineTools(doc.getNodeEngine('$.authConfig'));

// agentA and agentB can run concurrently; their changes land on the same undo stack
```

### Diff as a review step

After an agent turn, show the human exactly what changed before committing:

```ts
const { reply } = await runAgentLoop(tools, messages, adapter);

const changes = engine.diff();
// present changes to the human for review

if (humanApproves) {
  engine.accept();
} else {
  engine.decline();
}
```

The model never sees `accept` or `decline`. The human sees a clean diff of everything the model touched.

### Streaming output

```ts
const tools = createEngineTools(engine, { includeEphemeral: true });

// instruct the model: call beginEphemeral first, then stream to $.output, then commitEphemeral
const { reply } = await runAgentLoop(tools, messages, adapter);
```

Wire up a reactive binding on `engine.draft.output` and the UI updates live. When `commitEphemeral` fires, the entire stream collapses to one undo entry.

### Revert as a surgical undo

The `revert` tool lets the model undo a specific field without rewinding everything:

```ts
// model previously set $.config.timeout to 5000
// later in the conversation, the model decides that was wrong:
// tool call: revert({ path: '$.config.timeout' })
// restores only that field to its base value; nothing else changes
```

This is more surgical than `undo()` (which reverses the most recent operation regardless of what it was) and is safe to expose to the model because it only affects the draft.
