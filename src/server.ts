import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProfilerState } from './model/state.js';
import { handleTrace } from './instrument/trace.js';
import { handleMark } from './instrument/mark.js';
import { profileSummary } from './analysis/summary.js';
import { findHotspots } from './analysis/hotspots.js';
import { explainSpan } from './analysis/explain.js';

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

  server.registerTool(
    'profile_summary',
    {
      description:
        'Get headline performance numbers for a session: total time, tokens, cost, errors. Group by turn, operation kind, or execution lane to see where effort concentrated. Start here when you want to understand how a session went.',
      inputSchema: {
        group_by: z.enum(['kind', 'turn', 'lane']).optional(),
        time_range: z
          .object({
            start_ms: z.number(),
            end_ms: z.number(),
          })
          .optional(),
      },
    },
    (args) => {
      const result = profileSummary(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'hotspots',
    {
      description:
        'Find the most expensive operations by any dimension: wall time, tokens consumed, tokens generated, dollar cost, or error count. Returns a ranked list with ancestry chains. Use after profile_summary identifies a concentration of cost.',
      inputSchema: {
        dimension: z.string(),
        top_n: z.number().optional(),
        min_value: z.number().optional(),
      },
    },
    (args) => {
      const result = findHotspots(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'explain_span',
    {
      description:
        'Deep-dive into one expensive span. Shows its child breakdown, the causal chain of what happened, and any detected anti-patterns. Use when hotspots identified a specific span to investigate.',
      inputSchema: {
        span_id: z.string(),
      },
    },
    (args) => {
      const result = explainSpan(state.builder.profile, args);
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
