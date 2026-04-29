import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Engine } from '../engine.js';
import { createEditTools } from '../tools/index.js';

export type McpServerOptions = {
  /** Server name reported to MCP clients. Default: "patchwork" */
  name?: string;
  /** Server version. Default: "0.0.1" */
  version?: string;
};

/**
 * Create an MCP server wired to an Engine.
 *
 * Exposes all edit tools and the document as a readable resource.
 * Connect via stdio (default) or bring your own transport.
 *
 * ```ts
 * import { Engine } from 'patchwork';
 * import { createMcpServer } from 'patchwork/mcp';
 *
 * const engine = new Engine({ host: 'localhost', port: 8080 });
 * const { server, connect } = createMcpServer(engine);
 * await connect(); // stdio
 * ```
 */
export function createMcpServer(engine: Engine, opts?: McpServerOptions) {
  const tools = createEditTools(engine);

  const server = new Server(
    { name: opts?.name ?? 'patchwork', version: opts?.version ?? '0.0.1' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ─── Tools ────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    const result = tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text' as const, text: result.content }],
      isError: result.isError,
    };
  });

  // ─── Resources ────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'config://document',
        name: 'Current document',
        description: 'The full current state of the document (base + all edits)',
        mimeType: 'application/json',
      },
      {
        uri: 'config://base',
        name: 'Base document',
        description: 'The original base document before any edits',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;

    if (uri === 'config://document') {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(engine.export(), null, 2),
        }],
      };
    }

    if (uri === 'config://base') {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(engine.getBase(''), null, 2),
        }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // ─── Connect helper ───────────────────────────────────────────────────────

  async function connect(transport?: Transport) {
    await server.connect(transport ?? new StdioServerTransport());
  }

  return { server, connect };
}
