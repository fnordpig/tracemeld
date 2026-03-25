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
import { importProfile, mergeImportedProfile, buildImportResult } from './importers/import.js';
import { importNsightSqlite } from './importers/nsight-sqlite.js';
import { exportCollapsed } from './exporters/collapsed.js';
import { exportSpeedscope } from './exporters/speedscope.js';
import { exportChromeTrace } from './exporters/chrome-trace.js';
import { findHotpaths } from './analysis/hotpaths.js';
import { findBottlenecks } from './analysis/bottleneck.js';
import { findSpinpaths } from './analysis/spinpaths.js';
import { findStarvations } from './analysis/starvations.js';
import { focusFunction } from './analysis/focus-function.js';
import { diffBaselines } from './analysis/diff.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pako from 'pako';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string };

/* ---------- headline summary helpers (T4.4) ---------- */

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

function summarizeSummary(r: { totals: Record<string, number>; span_count: number; error_count: number; wall_duration_ms: number }): string {
  const dims = Object.entries(r.totals).map(([k, v]) => `${k}: ${fmt(v)}`).join(', ');
  const parts = [`${r.span_count} spans, wall ${fmt(r.wall_duration_ms)}ms`];
  if (dims) parts.push(dims);
  if (r.error_count) parts.push(`${r.error_count} errors`);
  return parts.join(' | ');
}

function summarizeHotspots(r: { dimension: string; entries: Array<{ name: string; pct_of_total: number; patterns: unknown[] }> }): string {
  if (!r.entries.length) return `No hotspots for ${r.dimension}.`;
  const top = r.entries[0];
  const patCount = r.entries.reduce((s, e) => s + e.patterns.length, 0);
  let line = `Top hotspot: ${top.name} (${top.pct_of_total.toFixed(1)}% of ${r.dimension})`;
  if (r.entries.length > 1) line += `. ${r.entries.length} entries total`;
  if (patCount) line += `. ${patCount} anti-pattern${patCount > 1 ? 's' : ''} detected`;
  return line + '.';
}

function summarizeBottlenecks(r: { dimension: string; entries: Array<{ name: string; pct_of_total: number; impact_score: number }> }): string {
  if (!r.entries.length) return `No bottlenecks for ${r.dimension}.`;
  const top = r.entries[0];
  return `#1 bottleneck: ${top.name} (${top.pct_of_total.toFixed(1)}% of ${r.dimension}, impact ${top.impact_score.toFixed(2)}). ${r.entries.length} total.`;
}

function summarizeWaste(r: { total_savings: Record<string, number>; items: Array<{ pattern: string }> }): string {
  if (!r.items.length) return 'No waste detected.';
  const savings = Object.entries(r.total_savings).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${fmt(v)}`).join(', ');
  return `${r.items.length} waste item${r.items.length > 1 ? 's' : ''} found${savings ? ` (potential savings: ${savings})` : ''}.`;
}

function summarizeExplain(r: { span: { name: string; duration_ms: number; error?: string }; children: unknown[]; patterns: unknown[]; recommendations: string[] }): string {
  let line = `${r.span.name}: ${fmt(r.span.duration_ms)}ms`;
  if (r.span.error) line += ` [ERROR]`;
  line += `, ${r.children.length} children`;
  if (r.patterns.length) line += `, ${r.patterns.length} pattern${r.patterns.length > 1 ? 's' : ''}`;
  if (r.recommendations.length) line += `, ${r.recommendations.length} recommendation${r.recommendations.length > 1 ? 's' : ''}`;
  return line + '.';
}

function withHeadline(headline: string, result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text' as const, text: headline },
      { type: 'text' as const, text: JSON.stringify(result) },
    ],
  };
}

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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      return withHeadline(summarizeSummary(result), result);
    },
  );

  server.registerTool(
    'hotspots',
    {
      description:
        'Find the most expensive operations by any dimension: wall time, tokens consumed, tokens generated, dollar cost, or error count. Returns a ranked list with ancestry chains. Use after profile_summary identifies a concentration of cost.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        dimension: z.string(),
        top_n: z.number().optional(),
        min_value: z.number().optional(),
      },
    },
    (args) => {
      const result = findHotspots(state.builder.profile, args, state.registry);
      return withHeadline(summarizeHotspots(result), result);
    },
  );

  server.registerTool(
    'explain_span',
    {
      description:
        'Deep-dive into one expensive span. Shows its child breakdown, the causal chain of what happened, and any detected anti-patterns. Use when hotspots identified a specific span to investigate.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        span_id: z.string(),
      },
    },
    (args) => {
      const result = explainSpan(state.builder.profile, args, state.registry);
      return withHeadline(summarizeExplain(result), result);
    },
  );

  server.registerTool(
    'find_waste',
    {
      description:
        'Identify work that didn\'t contribute to the final result: retries, unused reads, blind edits. Each waste item includes counterfactual savings and a concrete recommendation.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      return withHeadline(summarizeWaste(result), result);
    },
  );

  server.registerTool(
    'import_profile',
    {
      description:
        "Load profiling data from a file path or inline string. Auto-detects format (collapsed stacks, Chrome trace, V8 .cpuprofile, Gecko, pprof, Claude transcripts) or accepts a hint. Use when you want to analyze an existing profile.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        source: z.string().describe('File path or inline profile data string'),
        format: z.enum(['auto', 'collapsed', 'chrome_trace', 'claude_transcript', 'gecko', 'pprof', 'speedscope', 'nsight_sqlite', 'v8_cpuprofile']).optional(),
        lane_name: z.string().optional(),
        value_type: z.string().optional().describe(
          'Override value type key for collapsed format imports, e.g. "wall_ms". ' +
          'Collapsed stacks have no unit metadata; use this when you know what the values represent.',
        ),
        value_unit: z.enum(['nanoseconds', 'microseconds', 'milliseconds', 'seconds', 'bytes', 'none']).optional().describe(
          'Unit for the value type override. Default: "milliseconds" if value_type is set, else "none".',
        ),
        include_idle: z.boolean().optional().describe(
          'Include user_input idle spans in Claude transcript imports. Default: false. ' +
          'Set to true if you want to see how slow the human is.',
        ),
        nsight_options: z.object({
          max_kernels: z.number().optional(),
          time_range: z.object({
            start_ns: z.number(),
            end_ns: z.number(),
          }).optional(),
        }).optional(),
      },
    },
    async (args) => {
      let content: string;
      let symsJson: string | undefined;
      const format = args.format ?? 'auto';
      if (!args.source.includes('\n') && existsSync(args.source)) {
        const rawBuffer = readFileSync(args.source);

        // Detect Nsight SQLite: check magic bytes or format hint
        const isSqlite = (rawBuffer.length >= 16 && rawBuffer.subarray(0, 15).toString('ascii') === 'SQLite format 3')
          || format === 'nsight_sqlite';

        if (isSqlite) {
          state.reset();
          const imported = await importNsightSqlite(
            new Uint8Array(rawBuffer),
            args.lane_name ?? 'imported',
            args.nsight_options,
          );
          const result = buildImportResult(imported);
          mergeImportedProfile(state.builder, imported);
          state.invalidatePatternCache();
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }

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
      const importOpts: import('./importers/import.js').ImportOptions = {};
      if (args.value_type) {
        importOpts.collapsed = {
          value_type_key: args.value_type,
          value_type_unit: args.value_unit ?? 'milliseconds' as const,
        };
      }
      if (args.include_idle !== undefined) {
        importOpts.claude_transcript = { include_idle: args.include_idle };
      }
      const hasOpts = Object.keys(importOpts).length > 0;
      state.reset();
      const result = importProfile(content, args.lane_name ?? 'imported', format, state.builder, symsJson, hasOpts ? importOpts : undefined);
      state.invalidatePatternCache();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'export_profile',
    {
      description:
        "Export the current profile to a standard format for visualization. Supports 'collapsed' (for flamegraph tools), 'speedscope' (for speedscope.app), and 'chrome_trace' (for Perfetto UI / chrome://tracing). Returns the data as a string or writes to file.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        format: z.enum(['collapsed', 'speedscope', 'chrome_trace']).describe('Export format'),
        dimension: z.string().optional().describe('Value type key to export (default: first value type). Only used for collapsed format.'),
        include_idle: z.boolean().optional().describe('Include idle (user_input:) spans. Only used for speedscope format. Default: false.'),
        output_path: z.string().optional().describe('File path to write. If omitted, returns data inline.'),
      },
    },
    (args) => {
      let data: string;
      if (args.format === 'speedscope') {
        data = exportSpeedscope(state.builder.profile, { includeIdle: args.include_idle });
      } else if (args.format === 'chrome_trace') {
        data = JSON.stringify(exportChromeTrace(state.builder.profile, { include_idle: args.include_idle }));
      } else {
        data = exportCollapsed(state.builder.profile, args.dimension ?? 0);
      }

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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { dimension: z.string(), top_n: z.number().optional() },
    },
    (args) => {
      const result = findBottlenecks(state.builder.profile, args);
      return withHeadline(summarizeBottlenecks(result), result);
    },
  );

  server.registerTool(
    'spinpaths',
    {
      description: "Detect operations with high wall time but low useful output — busy-waiting, spinning, or inefficient processing. Flags spans that spent significant time without producing tokens, bytes, or other measurable work.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

  // ── Baseline & diff tools (T4.1-4.3) ──────────────────────────────

  server.registerTool(
    'save_baseline',
    {
      description:
        "Snapshot the current profile as a named baseline for future comparison. " +
        "Call this before and after optimizations to measure improvement. " +
        "The baseline is saved to the project's .tracemeld/baselines/ directory as a compact digest.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        name: z.string().describe('Baseline name, e.g. "auth-refactor-before" or "v2.1-release"'),
        checkpoint: z.enum(['before', 'after', 'baseline', 'release', 'custom'])
          .describe('What this checkpoint represents in the optimization lifecycle'),
        task: z.string().optional().describe('Description of the task or change being measured'),
        commit: z.string().optional().describe('Git commit hash, if known'),
        tags: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
        output_dir: z.string().optional()
          .describe('Directory to save baseline. Default: .tracemeld/baselines/'),
      },
    },
    async (args) => {
      // Lazy import to avoid circular dep issues during module load
      const { exportBaseline } = await import('./exporters/baseline.js');
      const dir = args.output_dir ?? '.tracemeld/baselines';
      mkdirSync(dir, { recursive: true });
      const safeName = args.name.replace(/[^a-zA-Z0-9_-]/g, '-');
      const filePath = join(dir, `${safeName}.baseline.json`);
      const digest = exportBaseline(state.builder.profile, {
        ...args.tags,
        checkpoint: args.checkpoint,
        task: args.task,
        commit: args.commit,
      }, state.registry);
      const json = JSON.stringify(digest, null, 2);
      writeFileSync(filePath, json, 'utf-8');
      const headline = Object.entries(digest.totals).map(([k, v]) => `${k}: ${fmt(v)}`).join(', ');
      return withHeadline(
        `Baseline saved: ${filePath} (${Buffer.byteLength(json)}B). ${headline}`,
        { file_path: filePath, size_bytes: Buffer.byteLength(json), totals: digest.totals, stats: digest.stats },
      );
    },
  );

  server.registerTool(
    'list_baselines',
    {
      description:
        "List available baselines in the project's .tracemeld/baselines/ directory. " +
        "Shows name, checkpoint type, creation date, task description, and headline totals. " +
        "Use this to find the right baseline for diff_profile comparison.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        baselines_dir: z.string().optional()
          .describe('Directory to scan. Default: .tracemeld/baselines/'),
      },
    },
    (args) => {
      const dir = args.baselines_dir ?? '.tracemeld/baselines';
      if (!existsSync(dir)) {
        return withHeadline('No baselines directory found.', { baselines: [] });
      }
      const files = readdirSync(dir).filter((f) => f.endsWith('.baseline.json')).sort();
      const baselines = files.map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as import('./exporters/baseline-types.js').BaselineDigest;
          return {
            file: f,
            path: join(dir, f),
            checkpoint: data.tags.checkpoint,
            task: data.tags.task,
            commit: data.tags.commit,
            created_at: data.created_at,
            totals: data.totals,
            stats: data.stats,
          };
        } catch {
          return { file: f, path: join(dir, f), error: 'Failed to parse' };
        }
      }).sort((a, b) => ((b as { created_at?: number }).created_at ?? 0) - ((a as { created_at?: number }).created_at ?? 0));

      return withHeadline(
        `${baselines.length} baseline${baselines.length !== 1 ? 's' : ''} found in ${dir}.`,
        { baselines },
      );
    },
  );

  server.registerTool(
    'diff_profile',
    {
      description:
        "Compare the current profile against a stored baseline. Shows what got faster, " +
        "what got slower, and by how much — across all cost dimensions. " +
        "Use after save_baseline to measure the impact of an optimization. " +
        "Identifies regressions even when the overall improved.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        baseline: z.string().describe('Path to a .baseline.json file, or baseline name to resolve from .tracemeld/baselines/'),
        dimension: z.string().optional().describe('Primary dimension to rank diffs by. Default: first value type.'),
        min_delta_pct: z.number().optional().describe('Minimum percentage change to report. Default: 5.'),
        normalize: z.boolean().optional().describe('Normalize totals before comparison. Default: true.'),
        dimension_map: z.record(z.string(), z.string()).optional().describe(
          'Map dimension keys across profiles, e.g. {"weight":"wall_ms"}. ' +
          'Default: auto-detects when each side has one non-zero dimension.',
        ),
      },
    },
    async (args) => {
      const { exportBaseline } = await import('./exporters/baseline.js');

      // Resolve baseline path
      let baselinePath = args.baseline;
      if (!baselinePath.endsWith('.baseline.json')) {
        const safeName = baselinePath.replace(/[^a-zA-Z0-9_-]/g, '-');
        baselinePath = join('.tracemeld/baselines', `${safeName}.baseline.json`);
      }
      if (!existsSync(baselinePath)) {
        return { content: [{ type: 'text' as const, text: `Baseline not found: ${baselinePath}` }] };
      }

      const beforeDigest = JSON.parse(readFileSync(baselinePath, 'utf-8')) as import('./exporters/baseline-types.js').BaselineDigest;
      const afterDigest = exportBaseline(state.builder.profile, { checkpoint: 'current' }, state.registry);

      const result = diffBaselines(beforeDigest, afterDigest, {
        dimension: args.dimension,
        min_delta_pct: args.min_delta_pct,
        normalize: args.normalize,
        dimension_map: args.dimension_map ?? 'auto',
      });

      // Build headline summary
      const parts: string[] = [];
      for (const [dim, h] of Object.entries(result.headline)) {
        const sign = h.delta >= 0 ? '+' : '';
        parts.push(`${dim}: ${sign}${h.delta_pct.toFixed(1)}%`);
      }
      let headline = parts.join(', ');
      if (result.regressions.length) headline += ` | ${result.regressions.length} regressions`;
      if (result.improvements.length) headline += ` | ${result.improvements.length} improvements`;
      if (result.normalized) headline += ` (normalized, factor: ${result.norm_factor?.toFixed(2)})`;

      return withHeadline(headline, result);
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────

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

1. Call list_baselines to check if previous baselines exist.
2. Call profile_summary with group_by="kind" to get headline numbers.
3. Look at which group has the highest pct_of_total on any dimension.
4. Call bottleneck on that dimension with top_n=5 to find the biggest optimization targets.
5. For each bottleneck that has a source field, read the source file at that line to understand the implementation.
6. Call hotpaths on the same dimension to see complete call chains.
7. Call find_waste to identify work that didn't contribute to the result.
8. If baselines exist from step 1, call diff_profile against the most recent one to see what changed.
9. Synthesize your findings into:
   - What's the #1 bottleneck and what does the source code reveal about why?
   - What work was wasted (with specific anti-patterns)?
   - If a baseline comparison was available: what improved, what regressed?
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

  server.registerPrompt(
    'optimization_loop',
    {
      title: 'Optimization Loop',
      description: 'Full before/after optimization cycle: baseline → analyze → change → re-profile → compare. Encodes the complete autonomous optimization workflow.',
      argsSchema: {
        task: z.string().describe('What optimization you are about to perform, e.g. "reduce npm test wall time"'),
      },
    },
    ({ task }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Optimization loop for: ${task}

Phase 1 — Baseline:
1. Call save_baseline with checkpoint="before" and task="${task}".
2. Call profile_summary, bottleneck, and find_waste to identify optimization targets.
3. Summarize the current state and what you plan to optimize.

Phase 2 — Implement changes:
4. Make the code changes based on your analysis.
5. Re-run the workload and re-import the new profile via import_profile.

Phase 3 — Compare:
6. Call save_baseline with checkpoint="after" and the same task="${task}".
7. Call diff_profile against the "before" baseline.
8. Synthesize: what improved, what regressed, what's the net impact across all dimensions?
9. If regressions exist, explain whether they are acceptable trade-offs or need further work.`,
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
