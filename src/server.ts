import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProfilerState } from './model/state.js';
import { handleTrace } from './instrument/trace.js';
import { handleMark } from './instrument/mark.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'tracemeld',
    version: '0.1.0',
  });

  const state = new ProfilerState();

  server.registerTool(
    'trace',
    {
      description:
        "Mark the start or end of a unit of work. Use this to instrument your own operations while you work: thinking, tool calls, file reads, bash commands, test runs. Call with action 'begin' before starting, 'end' when done. Cost data (tokens, time, bytes) goes on the 'end' call. Nesting is automatic.",
      inputSchema: {
        action: z.enum(['begin', 'end']),
        kind: z.string(),
        name: z.string().optional(),
        cost: z.record(z.string(), z.number()).optional(),
        error: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    (args) => {
      const result = handleTrace(state, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'mark',
    {
      description:
        "Record a notable instant: a test failure, a decision point, context window pressure, an unexpected result. Not a duration \u2014 a moment.",
      inputSchema: {
        what: z.string(),
        severity: z.enum(['info', 'warning', 'error']).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
    },
    (args) => {
      const result = handleMark(state, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
