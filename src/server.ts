import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProfilerState } from './model/state.js';
import { handleTrace } from './instrument/trace.js';
import { handleMark } from './instrument/mark.js';
import { profileSummary } from './analysis/summary.js';
import { findHotspots } from './analysis/hotspots.js';
import { explainSpan } from './analysis/explain.js';
import { findWaste } from './analysis/waste.js';
import { importProfile } from './importers/import.js';
import { exportCollapsed } from './exporters/collapsed.js';
import { findHotpaths } from './analysis/hotpaths.js';
import { findBottlenecks } from './analysis/bottleneck.js';
import { findSpinpaths } from './analysis/spinpaths.js';
import { findStarvations } from './analysis/starvations.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
      const result = findHotspots(state.builder.profile, args, state.registry);
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
      const result = explainSpan(state.builder.profile, args, state.registry);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'find_waste',
    {
      description:
        'Identify work that didn\'t contribute to the final result: retries, unused reads, blind edits. Each waste item includes counterfactual savings and a concrete recommendation.',
      inputSchema: {
        time_range: z
          .object({
            start_ms: z.number(),
            end_ms: z.number(),
          })
          .optional(),
      },
    },
    (args) => {
      const result = findWaste(state.builder.profile, state.registry, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'import_profile',
    {
      description:
        "Load profiling data from a file path or inline string. Auto-detects format (collapsed stacks, Chrome trace) or accepts a hint. Use when you want to analyze an existing profile.",
      inputSchema: {
        source: z.string().describe('File path or inline profile data string'),
        format: z.enum(['auto', 'collapsed', 'chrome_trace', 'gecko', 'pprof', 'speedscope']).optional(),
        lane_name: z.string().optional(),
      },
    },
    (args) => {
      let content: string;
      const format = args.format ?? 'auto';
      if (!args.source.includes('\n') && existsSync(args.source)) {
        // Binary formats (pprof) must be read as latin1 to preserve bytes
        const isBinary = format === 'pprof' || args.source.endsWith('.pb.gz') || args.source.endsWith('.prof');
        content = readFileSync(args.source, isBinary ? 'latin1' : 'utf-8');
      } else {
        content = args.source;
      }
      const result = importProfile(content, args.lane_name ?? 'imported', format, state.builder);
      state.invalidatePatternCache();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'export_profile',
    {
      description:
        "Export the current profile to a standard format for visualization. Currently supports 'collapsed' (for flamegraph tools). Returns the data as a string or writes to file.",
      inputSchema: {
        format: z.enum(['collapsed']).describe('Export format'),
        output_path: z.string().optional().describe('File path to write. If omitted, returns data inline.'),
      },
    },
    (args) => {
      const data = exportCollapsed(state.builder.profile);

      if (args.output_path) {
        writeFileSync(args.output_path, data, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              format: args.format,
              file_path: args.output_path,
              size_bytes: Buffer.byteLength(data, 'utf-8'),
              notes: [],
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            format: args.format,
            data,
            size_bytes: Buffer.byteLength(data, 'utf-8'),
            notes: [],
          }),
        }],
      };
    },
  );

  server.registerTool(
    'hotpaths',
    {
      description: "Find the critical call paths that account for the most cost. Unlike hotspots (flat ranking), this shows complete root-to-leaf paths. Use to understand which call chains dominate execution.",
      inputSchema: { dimension: z.string(), top_n: z.number().optional() },
    },
    (args) => {
      const result = findHotpaths(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'bottleneck',
    {
      description: "Find the single operations where optimization would have the most impact. Combines self-cost with path criticality — 'if you could speed up one thing, what would move the needle?'",
      inputSchema: { dimension: z.string(), top_n: z.number().optional() },
    },
    (args) => {
      const result = findBottlenecks(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'spinpaths',
    {
      description: "Detect operations with high wall time but low useful output — busy-waiting, spinning, or inefficient processing. Flags spans that spent significant time without producing tokens, bytes, or other measurable work.",
      inputSchema: { min_wall_ms: z.number().optional() },
    },
    (args) => {
      const result = findSpinpaths(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'starvations',
    {
      description: "Detect threads/lanes that are idle while others are active — indicates lock contention, unbalanced work, or serialization. Most useful with multi-threaded imported profiles (Gecko, Chrome trace).",
      inputSchema: { min_idle_pct: z.number().optional() },
    },
    (args) => {
      const result = findStarvations(state.builder.profile, args);
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
