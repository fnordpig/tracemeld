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
import { focusFunction } from './analysis/focus-function.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pako from 'pako';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'tracemeld',
    version: pkg.version,
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
      let symsJson: string | undefined;
      const format = args.format ?? 'auto';
      if (!args.source.includes('\n') && existsSync(args.source)) {
        const rawBuffer = readFileSync(args.source);
        // Detect gzip (magic bytes 0x1f 0x8b) and decompress
        if (rawBuffer.length >= 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b) {
          const decompressed = pako.ungzip(rawBuffer);
          content = Buffer.from(decompressed).toString('utf-8');
        } else {
          // Binary formats (pprof) must be read as latin1 to preserve bytes
          const isBinary = format === 'pprof' || args.source.endsWith('.pb.gz') || args.source.endsWith('.prof');
          content = isBinary ? rawBuffer.toString('latin1') : rawBuffer.toString('utf-8');
        }

        // Auto-detect samply .syms.json sidecar for Gecko profiles
        // samply names it: profile.json.gz → profile.json.syms.json (strips .gz)
        const basePath = args.source.endsWith('.gz') ? args.source.slice(0, -3) : args.source;
        const symsPath = basePath + '.syms.json';
        if (existsSync(symsPath)) {
          symsJson = readFileSync(symsPath, 'utf-8');
        }
        // Also check the literal path + .syms.json as fallback
        if (!symsJson) {
          const altSymsPath = args.source + '.syms.json';
          if (existsSync(altSymsPath)) {
            symsJson = readFileSync(altSymsPath, 'utf-8');
          }
        }
      } else {
        content = args.source;
      }
      const result = importProfile(content, args.lane_name ?? 'imported', format, state.builder, symsJson);
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
        dimension: z.string().optional().describe('Value type key to export (default: first value type)'),
        output_path: z.string().optional().describe('File path to write. If omitted, returns data inline.'),
      },
    },
    (args) => {
      const data = exportCollapsed(state.builder.profile, args.dimension ?? 0);

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

  server.registerTool(
    'focus_function',
    {
      description:
        "Zoom into a single function in the call graph. Shows its cost, who calls it (callers ranked by time spent), and what it calls (callees ranked by time spent). Use when you know which function to investigate and want to understand its role in the profile — where pressure comes from and where it flows.",
      inputSchema: {
        function_name: z.string().describe('Function name to focus on (exact or substring match)'),
        dimension: z.string().optional().describe('Cost dimension to rank by (default: first value type)'),
        top_n: z.number().optional().describe('Max callers/callees to return (default: 10)'),
      },
    },
    (args) => {
      const result = focusFunction(state.builder.profile, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'up_to_date',
    {
      description:
        'Check whether the running tracemeld version matches the latest published on npm. Reports both versions so you can tell the user if an upgrade is available.',
      inputSchema: {},
    },
    async () => {
      const running = pkg.version;
      let latest = 'unknown';
      try {
        const res = await fetch('https://registry.npmjs.org/tracemeld/latest');
        if (res.ok) {
          const data = await res.json() as { version: string };
          latest = data.version;
        }
      } catch {
        // network error — report what we can
      }
      const up_to_date = running === latest;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ running, latest, up_to_date }),
        }],
      };
    },
  );

  server.registerPrompt(
    'performance_review',
    {
      title: 'Performance Review',
      description: 'Step-by-step analysis of the current profile. Finds bottlenecks, traces call paths, identifies waste, and produces actionable recommendations with source locations.',
    },
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `You have a performance profile loaded in tracemeld. Analyze it step by step:

1. Call profile_summary with group_by="kind" to get headline numbers.
2. Look at which group has the highest pct_of_total on any dimension.
3. Call bottleneck on that dimension with top_n=5 to find the biggest optimization targets.
4. For each bottleneck that has a source field, read the source file at that line to understand the implementation. Use LSP hover and findReferences to understand the function's role.
5. Call hotpaths on the same dimension to see complete call chains.
6. Call find_waste to identify work that didn't contribute to the result.
7. Synthesize your findings into:
   - What's the #1 bottleneck and what does the source code reveal about why?
   - What work was wasted (with specific anti-patterns)?
   - Concrete recommendations with code-level specificity (cite file:line locations).`,
        },
      }],
    }),
  );

  server.registerPrompt(
    'optimize_for',
    {
      title: 'Optimize For Dimension',
      description: 'Targeted optimization analysis for a specific cost dimension (wall_ms, input_tokens, etc.)',
      argsSchema: {
        dimension: z.string().describe('The cost dimension to optimize: wall_ms, input_tokens, output_tokens, cost_usd, etc.'),
      },
    },
    ({ dimension }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Optimize for: ${dimension}

1. Call bottleneck with dimension="${dimension}" and top_n=5.
2. For each bottleneck with a source field, read the code at that location. Use LSP to understand what the function does and who calls it.
3. Call hotpaths with dimension="${dimension}" to see the full call chains.
4. Call find_waste to identify redundant work.
5. Produce a ranked list of optimizations, ordered by expected savings on ${dimension}. For each recommendation, cite the specific file:line and explain what to change.`,
        },
      }],
    }),
  );

  server.registerResource(
    'profile-summary',
    'profile://summary',
    {
      title: 'Current Profile Summary',
      description: 'Headline numbers from the active tracemeld profile — span count, error count, cost totals by kind.',
      mimeType: 'application/json',
    },
    () => {
      const summary = profileSummary(state.builder.profile, { group_by: 'kind' });
      return {
        contents: [{
          uri: 'profile://summary',
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
