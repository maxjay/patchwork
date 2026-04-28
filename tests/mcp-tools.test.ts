import { describe, it, expect } from 'vitest';
import { Engine } from '../src/index.js';
import { createEditTools } from '../src/tools/index.js';
import type { EditTool, ToolResult } from '../src/tools/index.js';

function call(tools: EditTool[], name: string, input: Record<string, unknown> = {}): ToolResult {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(input);
}

function json(result: ToolResult): unknown {
  return JSON.parse(result.content);
}

describe('MCP tools', () => {
  it('creates 11 tools', () => {
    const tools = createEditTools(new Engine({}));
    expect(tools).toHaveLength(11);
    const names = tools.map(t => t.name);
    expect(names).toContain('start_session');
    expect(names).toContain('end_session');
    expect(names).toContain('propose');
    expect(names).toContain('move');
    expect(names).toContain('get_value');
    expect(names).toContain('get_diff');
    expect(names).toContain('approve');
    expect(names).toContain('decline');
    expect(names).toContain('approve_all');
    expect(names).toContain('decline_all');
    expect(names).toContain('export');
  });

  it('each tool has name, description, inputSchema, handler', () => {
    const tools = createEditTools(new Engine({}));
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  describe('session lifecycle', () => {
    it('start_session and end_session', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      const start = call(tools, 'start_session');
      expect(json(start)).toEqual({ status: 'started' });

      const end = call(tools, 'end_session');
      expect(json(end)).toEqual({ status: 'ended' });
    });

    it('start_session fails if session already active', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      call(tools, 'start_session');
      const result = call(tools, 'start_session');
      expect(result.isError).toBe(true);
    });

    it('end_session fails if no session active', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      const result = call(tools, 'end_session');
      expect(result.isError).toBe(true);
    });
  });

  describe('propose', () => {
    it('proposes a change', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      call(tools, 'start_session');
      const result = call(tools, 'propose', { path: '/a', kind: 'replace', value: 2 });
      expect(json(result)).toEqual({ status: 'proposed', path: '/a' });
    });

    it('fails without session', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      const result = call(tools, 'propose', { path: '/a', kind: 'replace', value: 2 });
      expect(result.isError).toBe(true);
    });
  });

  describe('move', () => {
    it('moves a field', () => {
      const tools = createEditTools(new Engine({ a: 1, b: 2 }));
      call(tools, 'start_session');
      const result = call(tools, 'move', { from: '/a', to: '/c' });
      expect(json(result)).toEqual({ status: 'moved', from: '/a', to: '/c' });
    });
  });

  describe('get_value', () => {
    it('reads a value', () => {
      const tools = createEditTools(new Engine({ a: 1, b: 2 }));
      const result = call(tools, 'get_value', { path: '/a' });
      expect(json(result)).toEqual({ value: 1 });
    });

    it('reads root', () => {
      const engine = new Engine({ a: 1 });
      const tools = createEditTools(engine);
      const result = call(tools, 'get_value', { path: '' });
      expect(json(result)).toEqual({ value: { a: 1 } });
    });

    it('returns undefined for non-existent path', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      const result = call(tools, 'get_value', { path: '/nope' });
      expect(result.isError).toBeUndefined();
      expect(json(result)).toEqual({ value: undefined });
    });
  });

  describe('get_diff', () => {
    it('returns pending proposals', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 99 });
      const result = call(tools, 'get_diff');
      const data = json(result) as { ops: unknown[] };
      expect(data.ops).toHaveLength(1);
    });
  });

  describe('approve and decline', () => {
    it('approves a proposal', () => {
      const engine = new Engine({ a: 1 });
      const tools = createEditTools(engine);
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 99 });
      const result = call(tools, 'approve', { path: '/a' });
      expect(json(result)).toEqual({ status: 'approved', path: '/a' });
      expect(engine.export()).toEqual({ a: 99 });
    });

    it('declines a proposal', () => {
      const engine = new Engine({ a: 1 });
      const tools = createEditTools(engine);
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 99 });
      const result = call(tools, 'decline', { path: '/a' });
      expect(json(result)).toEqual({ status: 'declined', path: '/a' });
      expect(engine.export()).toEqual({ a: 1 });
    });

    it('approve fails for non-existent proposal', () => {
      const tools = createEditTools(new Engine({ a: 1 }));
      call(tools, 'start_session');
      const result = call(tools, 'approve', { path: '/nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('approve_all and decline_all', () => {
    it('approves all proposals', () => {
      const engine = new Engine({ a: 1, b: 2 });
      const tools = createEditTools(engine);
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 10 });
      call(tools, 'propose', { path: '/b', kind: 'replace', value: 20 });
      const result = call(tools, 'approve_all');
      expect(json(result)).toEqual({ status: 'approved_all' });
      expect(engine.export()).toEqual({ a: 10, b: 20 });
    });

    it('declines all proposals', () => {
      const engine = new Engine({ a: 1, b: 2 });
      const tools = createEditTools(engine);
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 10 });
      call(tools, 'propose', { path: '/b', kind: 'replace', value: 20 });
      const result = call(tools, 'decline_all');
      expect(json(result)).toEqual({ status: 'declined_all' });
      expect(engine.export()).toEqual({ a: 1, b: 2 });
    });
  });

  describe('export', () => {
    it('exports the document', () => {
      const engine = new Engine({ a: 1 });
      const tools = createEditTools(engine);
      const result = call(tools, 'export');
      expect(json(result)).toEqual({ document: { a: 1 } });
    });

    it('reflects approved changes', () => {
      const engine = new Engine({ a: 1 });
      const tools = createEditTools(engine);
      call(tools, 'start_session');
      call(tools, 'propose', { path: '/a', kind: 'replace', value: 99 });
      call(tools, 'approve', { path: '/a' });
      call(tools, 'end_session');
      const result = call(tools, 'export');
      expect(json(result)).toEqual({ document: { a: 99 } });
    });
  });

  describe('full workflow', () => {
    it('LLM-style: start, propose multiple, user reviews, export', () => {
      const engine = new Engine({ host: 'localhost', port: 8080, debug: false });
      const tools = createEditTools(engine);

      call(tools, 'start_session');
      call(tools, 'propose', { path: '/host', kind: 'replace', value: '0.0.0.0' });
      call(tools, 'propose', { path: '/debug', kind: 'replace', value: true });
      call(tools, 'propose', { path: '/logLevel', kind: 'add', value: 'info' });

      // User approves host change, declines debug, approves logLevel
      call(tools, 'approve', { path: '/host' });
      call(tools, 'decline', { path: '/debug' });
      call(tools, 'approve', { path: '/logLevel' });

      call(tools, 'end_session');

      const result = call(tools, 'export');
      expect(json(result)).toEqual({
        document: { host: '0.0.0.0', port: 8080, debug: false, logLevel: 'info' },
      });
    });
  });
});
