# mcp-profiler: Design specification

A stateless MCP server that ingests profiling data from multiple sources, provides LLM-native performance analysis, and exports to standard visualization formats. Designed so that an LLM agent like Claude Code can instrument its own work, analyze its performance, detect anti-patterns, and receive actionable recommendations — all through a tool interface shaped for how LLMs reason about optimization.

---

## 1. Core principles

**Stateless.** No database, no persistence across sessions. The server holds an in-memory `Profile` built from imported data or live instrumentation. When the process ends, the data is gone. Export before you close.

**Format-faithful ingestion.** Importers are based on speedscope's proven parsing for pprof, collapsed stacks, Chrome trace events, Gecko profile, and speedscope's own format. We reuse their format-detection logic and mapping strategies. The canonical model is our own.

**Cognitively ergonomic tools.** Every MCP tool name, description, parameter name, and return value is designed to activate the right inferential path in an LLM. Tools are named as thoughts ("what's slow?"), not data operations ("query metric table"). Return values include semantic breadcrumbs that lead to the next analysis step.

**Multi-dimensional cost model.** Unlike traditional profilers that measure one thing (CPU time, memory), LLM agent profiling measures wall time, input tokens, output tokens, dollar cost, and bytes I/O simultaneously. The canonical model supports N value dimensions per sample/span, declared in a schema at profile creation.

---

## 2. Canonical data model

All imported data and live instrumentation is normalized into this model. All analysis tools query it. All exporters project from it.

### 2.1 TypeScript interfaces

```typescript
/**
 * The top-level container. One Profile per MCP server lifetime.
 * Multiple profiles can be held if comparing, but typical usage is one.
 */
interface Profile {
  id: string;
  name: string;
  created_at: number; // ms since epoch
  
  /** Schema: what dimensions are measured. Aligned to values[] on Samples and Spans. */
  value_types: ValueType[];
  
  /** Category definitions for grouping frames. */
  categories: Category[];
  
  /** Shared, deduplicated frame table. All spans/samples reference frames by index. */
  frames: Frame[];
  
  /** Execution lanes (threads, processes, agent tracks). */
  lanes: Lane[];
  
  /** Profile-level metadata. */
  metadata: Record<string, unknown>;
}

interface ValueType {
  key: string;        // e.g. "wall_ms", "input_tokens", "output_tokens", "cost_usd", "bytes_read"
  unit: Unit;
  description?: string;
}

type Unit = "nanoseconds" | "microseconds" | "milliseconds" | "seconds"
           | "bytes" | "none";

interface Category {
  name: string;       // e.g. "thinking", "tool_execution", "idle"
  color?: string;     // hint for visualization
  subcategories?: string[];
}

/**
 * A frame identifies a unit of work. Deduplicated by (name, file, line, col, category).
 * Referenced by index into Profile.frames[].
 */
interface Frame {
  name: string;       // e.g. "bash:npm test", "file_read:src/auth.ts", "thinking:planning"
  file?: string;
  line?: number;
  col?: number;
  category_index?: number; // index into Profile.categories[]
  metadata?: Record<string, unknown>;
}

/**
 * An execution lane. Maps to: a thread (Gecko), a pid+tid (Chrome trace),
 * a goroutine (pprof label), or an agent execution track (LLM).
 */
interface Lane {
  id: string;
  name: string;
  pid?: number;
  tid?: number;
  kind: "main" | "worker" | "agent" | "subprocess" | "custom";
  samples: Sample[];
  spans: Span[];
  markers: Marker[];
}

/**
 * A sample: a snapshot of a stack at a point in time, with associated weights.
 * This is what pprof and collapsed stacks produce.
 */
interface Sample {
  /** Timestamp in ms since epoch. Null for aggregate-only formats (pprof, collapsed). */
  timestamp: number | null;
  
  /** Stack: array of frame indices, bottom (root) to top (leaf). */
  stack: number[];
  
  /** Measurement values, aligned to Profile.value_types[]. */
  values: number[];
  
  /** Per-sample labels (pprof labels, arbitrary tags). */
  labels?: Record<string, string | number>[];
}

/**
 * A span: a duration of work with explicit start and end.
 * This is what Chrome trace events and LLM agent instrumentation produce.
 */
interface Span {
  id: string;
  
  /** Index into Profile.frames[]. */
  frame_index: number;
  
  /** Parent span ID for tree structure. Null for root spans. */
  parent_id: string | null;
  
  /** Absolute timestamps in ms since epoch. */
  start_time: number;
  end_time: number;
  
  /** Measurement values, aligned to Profile.value_types[]. */
  values: number[];
  
  /** Arbitrary structured data (Chrome trace args, LLM tool output, etc). */
  args: Record<string, unknown>;
  
  /** Error information if this span represents a failure. */
  error?: string;
  
  /** Child span IDs, maintained for tree traversal. */
  children: string[];
}

/**
 * A marker: an instant annotation on the timeline.
 * Maps to Gecko markers. Used for point events, measurements, flags.
 */
interface Marker {
  timestamp: number;
  name: string;
  category_index?: number;
  severity?: "info" | "warning" | "error";
  data?: Record<string, unknown>;
  /** Optional duration for interval markers (Gecko supports this). */
  end_time?: number;
}
```

### 2.2 Frame naming convention

Frames follow a `{kind}:{detail}` convention. The kind prefix enables aggregation in flamegraph views (speedscope Sandwich view groups by frame name). The detail suffix provides specificity.

```
session:refactor-auth-module
  turn:1
    thinking:planning
    thinking:exploring
  turn:2
    thinking:planning
    tool_call:bash
      bash:find src -name "*.ts" -type f
    tool_call:file_read
      file_read:src/auth.ts
    thinking:analyzing
    tool_call:file_write
      file_write:src/auth.ts
    tool_call:bash
      bash:npm test --testPathPattern auth
    thinking:synthesis
  turn:3
    user_input:waiting
```

**Rules for frame names:**
- The kind is a free string but should come from the well-known set: `session`, `turn`, `thinking`, `tool_call`, `bash`, `file_read`, `file_write`, `search`, `api_call`, `validation`, `user_input`, `custom`.
- The detail is human-readable. For bash: the first meaningful command. For file ops: the path. For thinking: a semantic label (planning, analyzing, synthesis).
- Frame deduplication matches on exact string equality. `bash:npm test` and `bash:npm test --coverage` are different frames. This is deliberate — they represent different operations even if the command is similar.

### 2.3 Default value types for LLM agent profiling

When creating a profile from live instrumentation (no imported data), use these defaults:

```typescript
const LLM_VALUE_TYPES: ValueType[] = [
  { key: "wall_ms",        unit: "milliseconds", description: "Wall-clock duration" },
  { key: "input_tokens",   unit: "none",         description: "Input/prompt tokens consumed" },
  { key: "output_tokens",  unit: "none",         description: "Output/completion tokens generated" },
  { key: "cost_usd",       unit: "none",         description: "Estimated dollar cost" },
  { key: "bytes_read",     unit: "bytes",        description: "Bytes read from disk/network" },
  { key: "bytes_written",  unit: "bytes",        description: "Bytes written to disk/network" },
];
```

---

## 3. Importers

Based on speedscope's format detection and parsing. Each importer reads a specific format and produces a `Profile` in the canonical model.

### 3.1 Format detection

Auto-detection (the `"auto"` format option) follows speedscope's strategy:

1. If the input is a gzip-compressed protobuf → try **pprof**.
2. If the input is JSON with `$schema` containing `speedscope` → **speedscope**.
3. If the input is JSON with `traceEvents` array or array of objects with `ph` field → **Chrome trace**.
4. If the input is JSON with `meta.version` and `threads` array → **Gecko profile**.
5. If the input is plain text with lines matching `frame;frame;frame N` → **collapsed stacks**.
6. Fail with `unknown_format`.

### 3.2 Importer: pprof

**Input:** gzip-compressed protobuf per `profile.proto`.

**Mapping:**
- `profile.sample_type[]` → `Profile.value_types[]`. Each sample type becomes a value dimension.
- `profile.sample[]` → `Sample[]` on a single lane named "main".
- `sample.location_id[]` → resolve through `Location` → `Function` to build `Frame` entries. Frame name = `Function.name`. Frame file/line from `Function.filename` / `Line.line`.
- `sample.value[]` → `Sample.values[]`, aligned to value_types.
- `sample.label[]` → `Sample.labels[]`.
- Timestamps: pprof has no per-sample timestamps. `Sample.timestamp = null`. Profile-level `duration_nanos` and `time_nanos` set `Profile.created_at`.

**Notes:** pprof's `Mapping` (binary/library information) maps to `Frame.metadata.mapping`. The string table deduplication maps directly to our frame deduplication.

### 3.3 Importer: collapsed stacks

**Input:** Plain text. One line per stack. Format: `frame;frame;frame count\n`.

**Mapping:**
- Each unique frame string → `Frame` entry with `name = string`.
- One `ValueType` with `key: "weight"`, `unit: "none"`.
- Each line → `Sample` with `stack = [frame indices bottom to top]`, `values = [count]`, `timestamp = null`.
- Single lane named "main".

**Notes:** No source locations, no timestamps, no structured frame names. This is the lowest-fidelity import. Frame names may contain module separators like backtick (`module\`function`) which should be preserved as-is.

### 3.4 Importer: Chrome Trace Event Format

**Input:** JSON. Either `{ traceEvents: [...] }` or a raw array of event objects.

**Mapping:**
- Phase `B` (begin) + `E` (end) event pairs → `Span`. Match by `name` + `tid`, stack order. `ts` (microseconds) → `start_time` / `end_time` in ms.
- Phase `X` (complete) events → `Span` directly. `ts` → `start_time`, `ts + dur` → `end_time`.
- Phase `I` / `i` (instant) → `Marker`.
- Phase `C` (counter) → `Marker` with `data` containing counter values.
- Phase `M` (metadata) with `name: "process_name"` or `name: "thread_name"` → Lane naming.
- `pid` + `tid` → Lane identity. Each unique (pid, tid) pair creates a Lane.
- Event `name` → Frame name. `cat` → Category. `args` → `Span.args`.
- One `ValueType`: `{ key: "wall_ms", unit: "milliseconds" }`. Span values computed from duration.

**Notes:** Chrome trace has no multi-dimensional values. Duration is the only measurement. Any additional data lives in `args`.

### 3.5 Importer: Gecko profile

**Input:** JSON per the Gecko profile format.

**Mapping:**
- `threads[]` → `Lane[]`. Thread `name` → Lane name. Thread `pid` → Lane pid.
- Per-thread `samples` (columnar: `stack[]`, `time[]`, `weight[]`) → `Sample[]`. Stack references resolve through `stackTable` (prefix-tree) → `frameTable` → `funcTable` → `stringTable`.
- Per-thread `markers` (columnar: `name[]`, `startTime[]`, `endTime[]`, `data[]`) → `Marker[]` (instant if startTime == endTime) or `Span[]` (if they have duration and represent work intervals).
- `funcTable` entries → `Frame[]`. Name from `stringTable[funcTable.name[i]]`. File/line from `funcTable.fileName[]` / `funcTable.lineNumber[]`.
- `meta.categories[]` → `Category[]`.
- One `ValueType`: `{ key: "wall_ms", unit: "milliseconds" }`. Sample weights from the `weight` column.

**Notes:** Gecko's columnar format is optimized for GC performance, not readability. The importer must reconstruct the prefix-tree stacks into flat frame arrays. Gecko markers with payloads (e.g. GC markers, network markers) become Markers with their payload in `data`.

### 3.6 Importer: speedscope

**Input:** JSON with `$schema: "https://www.speedscope.app/file-format-schema.json"`.

**Mapping:**
- `shared.frames[]` → `Frame[]` directly. Name, file, line, col all map 1:1.
- `profiles[]` → one Lane per profile. Profile `name` → Lane name.
- **Evented profiles** (`type: "evented"`): Reconstruct spans from `O` (open) / `C` (close) events. Each O/C pair with matching `frame` index → `Span`. Event `at` field → timestamps, offset by `startValue`.
- **Sampled profiles** (`type: "sampled"`): `samples[]` (arrays of frame indices) → `Sample[]`. `weights[]` → `Sample.values[]`.
- Profile `unit` → `ValueType.unit`. One ValueType per profile.

**Notes:** speedscope files may contain multiple profiles (e.g., different threads or different views of the same data). Each becomes a separate Lane.

---

## 4. MCP tool interface

### 4.1 Design philosophy

Tools are organized by the cognitive stage of the performance reasoning chain:

1. **Instrument** — tools used during task execution, minimal overhead.
2. **Notice** — "how did that go?" Entry point to analysis.
3. **Locate** — "where is the cost?" Find hotspots.
4. **Diagnose** — "why is it expensive?" Explain causes.
5. **Prescribe** — "what should change?" Get recommendations.
6. **Verify** — "did it help?" Compare before/after.
7. **Export** — bridge to visual tools and interop with other formats.

Tool descriptions are written as the thought the LLM has right before reaching for the tool. Return values include semantic breadcrumbs that activate the next reasoning step.

### 4.2 Tool definitions

#### `trace` — Instrument

Mark the start or end of a unit of work. Use this to instrument your own operations while you work: thinking, tool calls, file reads, bash commands, test runs. Call with action "begin" before starting, "end" when done. Cost data (tokens, time, bytes) goes on the "end" call. Nesting is automatic.

```typescript
// Input schema
interface TraceInput {
  /** "begin" to open a span, "end" to close the most recent matching span. */
  action: "begin" | "end";
  
  /** What kind of work: "thinking", "bash", "file_read", "file_write",
      "search", "validation", "api_call", "user_input", or any custom string. */
  kind: string;
  
  /** Human-readable detail. Optional on "begin"; defaults to kind.
      Example: "npm test --coverage", "src/auth.ts", "planning edit approach". */
  name?: string;
  
  /** Cost dimensions, typically provided on "end". Keys from the value_types schema.
      Example: { wall_ms: 3400, input_tokens: 12000, output_tokens: 800 } */
  cost?: Record<string, number>;
  
  /** Error message if this span represents a failure. Only on "end". */
  error?: string;
  
  /** Arbitrary metadata to attach. */
  metadata?: Record<string, unknown>;
}

// Return value
interface TraceResult {
  span_id: string;         // The span that was opened or closed
  depth: number;           // Current nesting depth (0 = root)
  elapsed_ms?: number;     // Duration, only on "end"
  parent_id?: string;      // Parent span ID, only on "begin"
}
```

**Implementation notes:**
- Maintains an implicit span stack per lane. `begin` pushes, `end` pops.
- On `begin`: auto-registers the frame (`{kind}:{name}`) if not seen before. Creates the span with `parent_id` set to the current stack top.
- On `end`: matches the most recent open span with the same `kind`. If `kind` doesn't match the stack top, it's a nesting error — close the top span first (auto-close with a warning in metadata), then close the requested one. This is forgiving because LLMs sometimes forget to close spans.
- `cost` values are merged into `Span.values[]` aligned by key → value_type index. Missing keys default to 0.

#### `mark` — Instrument

Record a notable instant: a test failure, a decision point, context window pressure, an unexpected result. Not a duration — a moment. Use when something happens that you'll want to see on the timeline later.

```typescript
interface MarkInput {
  /** What happened. Free-form string.
      Example: "tests failed: 3 assertions", "context window at 78% capacity" */
  what: string;
  
  severity?: "info" | "warning" | "error";
  
  /** Structured data about the event. */
  data?: Record<string, unknown>;
}

interface MarkResult {
  marker_id: string;
  timestamp: number;
}
```

#### `profile_summary` — Notice

Get headline performance numbers for a session: total time, tokens, cost, errors. Group by turn, operation kind, or execution lane to see where effort concentrated. Start here when you want to understand how a session went.

```typescript
interface ProfileSummaryInput {
  /** How to group the breakdown. Default: "kind". */
  group_by?: "kind" | "turn" | "lane";
  
  /** Only analyze spans in this time range. */
  time_range?: { start_ms: number; end_ms: number };
}

interface ProfileSummaryResult {
  /** Headline totals across all dimensions. */
  totals: Record<string, number>; // key = value_type.key, value = sum
  
  /** Per-group breakdown. */
  groups: ProfileGroup[];
  
  /** Total span count, error count. */
  span_count: number;
  error_count: number;
  
  /** Total wall-clock duration including idle. */
  wall_duration_ms: number;
  
  /** Wall-clock duration excluding user_input spans. */
  active_duration_ms: number;
}

interface ProfileGroup {
  /** The group key: a kind string, turn number, or lane name. */
  key: string;
  
  /** Cost totals for this group, per value_type. */
  totals: Record<string, number>;
  
  /** Percentage of the profile total, per value_type. */
  pct_of_total: Record<string, number>;
  
  /** Number of spans in this group. */
  span_count: number;
  error_count: number;
  
  /** BREADCRUMB: If this group's pct_of_total exceeds 40% on any dimension,
      it's flagged for investigation. The field names the dimension and
      suggests calling hotspots. */
  investigate?: {
    dimension: string;
    pct: number;
    hint: string; // e.g. "72% of input_tokens — call hotspots with dimension='input_tokens'"
  };
}
```

#### `hotspots` — Locate

Find the most expensive operations by any dimension: wall time, tokens consumed, tokens generated, dollar cost, or error count. Returns a ranked list with ancestry chains and detected anti-patterns. Use after profile_summary identifies a concentration of cost.

```typescript
interface HotspotsInput {
  /** Which cost dimension to rank by. */
  dimension: string; // any value_type.key, or "errors"
  
  /** How many results. Default: 10. */
  top_n?: number;
  
  /** Minimum self-cost to include (filters noise). */
  min_value?: number;
}

interface HotspotsResult {
  dimension: string;
  entries: HotspotEntry[];
}

interface HotspotEntry {
  span_id: string;
  
  /** Full ancestry: ["session:refactor", "turn:3", "tool_call:bash", "bash:npm test"] */
  ancestry: string[];
  
  /** The span's frame name. */
  name: string;
  
  /** Cost breakdown for this span (self + children). */
  total_cost: Record<string, number>;
  
  /** Self cost (excluding children). */
  self_cost: Record<string, number>;
  
  /** Percentage of profile total for the ranked dimension. */
  pct_of_total: number;
  
  /** BREADCRUMB: Detected anti-patterns on this span.
      Each pattern has a name, a short explanation, and a severity. */
  patterns: DetectedPattern[];
  
  /** BREADCRUMB: Pointer to the next analysis step. */
  investigate: string; // e.g. "call explain_span with span_id 'xyz' to see the breakdown"
}

interface DetectedPattern {
  name: string;        // e.g. "redundant_read", "retry_loop", "context_inflation"
  description: string; // Human-readable one-liner
  severity: "info" | "warning" | "critical";
  evidence: Record<string, unknown>; // Pattern-specific data
}
```

#### `explain_span` — Diagnose

Deep-dive into one expensive span. Shows its child breakdown, the causal decision chain that led to it, and detected anti-patterns like "redundant_read", "retry_loop", or "full_suite_single_change". Use when hotspots identified a specific span to investigate.

```typescript
interface ExplainSpanInput {
  span_id: string;
}

interface ExplainSpanResult {
  /** The span itself. */
  span: {
    name: string;
    kind: string;
    start_time: number;
    end_time: number;
    duration_ms: number;
    cost: Record<string, number>;
    error?: string;
    args: Record<string, unknown>;
  };
  
  /** Full ancestry chain to the root. */
  ancestry: string[];
  
  /** Direct children, sorted by the largest cost dimension. */
  children: {
    span_id: string;
    name: string;
    cost: Record<string, number>;
    pct_of_parent: Record<string, number>;
    error?: string;
  }[];
  
  /** The causal chain: a narrative sequence of what happened in this span.
      Ordered chronologically. Each step is a child span or marker. */
  causal_chain: {
    timestamp: number;
    event: string;    // e.g. "read src/auth.ts (12KB, 3400 tokens)"
    kind: string;     // e.g. "file_read"
    cost: Record<string, number>;
    outcome?: string; // e.g. "content used in next edit", "content never referenced"
  }[];
  
  /** All anti-patterns detected within this span's subtree. */
  patterns: DetectedPattern[];
  
  /** BREADCRUMB: Concrete recommendations based on detected patterns. */
  recommendations: string[];
}
```

#### `find_waste` — Prescribe

Identify work that didn't contribute to the final result: retries, unused reads, superseded tool calls, reverted edits. Each waste item includes counterfactual savings and a concrete recommendation.

```typescript
interface FindWasteInput {
  /** Filter to a specific time range or leave empty for the full session. */
  time_range?: { start_ms: number; end_ms: number };
}

interface FindWasteResult {
  /** Total savings if all waste were eliminated. */
  total_savings: Record<string, number>;
  
  /** Individual waste items, sorted by largest savings. */
  items: WasteItem[];
}

interface WasteItem {
  pattern: string;           // Anti-pattern name
  description: string;       // What happened, human-readable
  span_ids: string[];        // The spans involved
  
  /** What would have been saved. */
  counterfactual_savings: Record<string, number>;
  
  /** Concrete recommendation. */
  recommendation: string;
  
  /** Supporting evidence. */
  evidence: Record<string, unknown>;
}
```

#### `token_flow` — Diagnose

Trace how the context window fills across turns: what fraction is system prompt, conversation history, tool results, and generation. Identifies context inflation and suggests compaction points.

```typescript
interface TokenFlowInput {
  /** Omit to analyze the full session. */
  turn_range?: { from: number; to: number };
}

interface TokenFlowResult {
  turns: TurnTokenBreakdown[];
  
  /** Overall token efficiency: output_tokens / input_tokens ratio. */
  overall_efficiency: number;
  
  /** BREADCRUMB: Points where context could be compacted. */
  compaction_opportunities: {
    after_turn: number;
    reason: string;      // e.g. "history is 68% of input; summarization would save ~4000 tokens"
    estimated_savings: number;
  }[];
}

interface TurnTokenBreakdown {
  turn: number;
  input_tokens: number;
  output_tokens: number;
  
  /** Breakdown of input tokens by source. */
  input_breakdown: {
    system_prompt: number;
    conversation_history: number;
    tool_results: number;
    user_message: number;
  };
  
  /** Ratio: conversation_history / input_tokens. High = inflation. */
  history_ratio: number;
  
  /** Cumulative cost up to and including this turn. */
  cumulative_cost: Record<string, number>;
}
```

#### `compare` — Verify

Measure improvement: compare two profiles or two time ranges across all cost dimensions. Shows deltas, percentage changes, and per-kind breakdowns. Warns if any dimension regressed.

```typescript
interface CompareInput {
  /** "before" baseline. A profile ID or time range within the current profile. */
  before: string | { start_ms: number; end_ms: number };
  
  /** "after" candidate. A profile ID or time range within the current profile. */
  after: string | { start_ms: number; end_ms: number };
}

interface CompareResult {
  /** Per-dimension deltas. Negative = improvement, positive = regression. */
  deltas: Record<string, { before: number; after: number; delta: number; pct_change: number }>;
  
  /** Per-kind breakdown of where improvement/regression came from. */
  by_kind: {
    kind: string;
    deltas: Record<string, { before: number; after: number; delta: number; pct_change: number }>;
  }[];
  
  /** BREADCRUMB: Any dimension that regressed, even if overall improved. */
  regressions: {
    dimension: string;
    pct_change: number;
    note: string;
  }[];
}
```

#### `export_profile` — Export

Save the profile in a format that standard visualization tools can open: speedscope, Chrome tracing, Firefox Profiler, pprof, or collapsed stacks.

```typescript
interface ExportProfileInput {
  /** Target format. */
  format: "speedscope" | "chrome_trace" | "gecko" | "pprof" | "collapsed";
  
  /** Which value dimensions to include. Default: all.
      For speedscope: generates one profile per dimension.
      For pprof: maps to sample_type[].
      For collapsed/chrome_trace: uses the first specified dimension as weight. */
  dimensions?: string[];
  
  /** Whether to include user_input (idle) spans. Default: false.
      When true for speedscope: generates an additional set of profiles with idle included. */
  include_idle?: boolean;
  
  /** Output file path. If omitted, returns the data as a string in the result. */
  output_path?: string;
}

interface ExportProfileResult {
  format: string;
  file_path?: string;
  /** Byte size of the output. */
  size_bytes: number;
  /** Number of profiles/tracks in the output. */
  profile_count: number;
  /** Informational notes about the export (e.g., "user_input spans excluded"). */
  notes: string[];
}
```

#### `import_profile` — Import

Load profiling data from a file or string. Auto-detects format or accepts a hint. Merges into the current session as a new lane, optionally nested under an existing span.

```typescript
interface ImportProfileInput {
  /** File path or raw data string. */
  source: string;
  
  /** Format hint. Default: "auto" (detect from content). */
  format?: "auto" | "pprof" | "collapsed" | "chrome_trace" | "gecko" | "speedscope";
  
  /** If provided, the imported data nests under this span in the timeline.
      Useful when importing a pprof from a subprocess the agent ran. */
  attach_to_span?: string;
  
  /** Override the lane name for the imported data. */
  lane_name?: string;
}

interface ImportProfileResult {
  format_detected: string;
  lanes_added: number;
  frames_added: number;
  samples_added: number;
  spans_added: number;
  value_types: string[]; // The dimensions found in the imported data
}
```

---

## 5. Anti-pattern detection engine

The engine runs heuristics over the span tree to detect named anti-patterns. These names serve as a shared vocabulary between the analysis engine and the LLM — the pattern name activates relevant reasoning about the fix.

### 5.1 Anti-pattern definitions

Each pattern has: a unique name, a detection heuristic, and a recommendation template.

#### Token waste

| Pattern | Detection heuristic | Recommendation |
|---------|-------------------|----------------|
| `redundant_read` | Same `file_read:X` frame appears 2+ times in a turn with no intervening `file_write:X`. | "Read the file once, retain content in reasoning, plan edits before re-reading." |
| `large_context_small_edit` | A `file_read` span with `input_tokens > 2000` is followed by a `file_write` to the same file with `output_tokens < 50`. Ratio > 40:1. | "Use a targeted read (line range) or grep to find the relevant section." |
| `context_inflation` | In a turn, calculate: `history_tokens / total_input_tokens > 0.6` AND `(user_message_tokens + tool_result_tokens) / total_input_tokens < 0.2`. | "Summarize and compact conversation history." |
| `unused_output` | A tool call's output is >500 tokens, and no subsequent `thinking` span's content or tool call references content from that output. Detection: the output's distinctive terms don't appear in any later span's args/metadata within the same turn. | "Scope tool calls more tightly. Use grep/find instead of cat." |

#### Execution waste

| Pattern | Detection heuristic | Recommendation |
|---------|-------------------|----------------|
| `retry_loop` | A span has `error != null`, and its next sibling span has the same `frame_index`. Detected as 2+ consecutive sibling spans with identical frame and intervening errors. | "Read the error carefully before retrying. Consider a different approach." |
| `full_suite_single_change` | A `validation` or `bash` span with `wall_ms > 30000` follows a `file_write` that touched 1 file. The bash command does not contain path-scoping flags (`--testPathPattern`, `-k`, `--grep`, `--filter`). | "Scope test runs to affected files." |
| `blind_edit` | A `file_write:X` span has no preceding `file_read:X` in the current turn or its immediate predecessor turn. | "Always read the current state before editing." |
| `reverted_work` | A sequence within a turn: `file_write:X` → (any spans) → `file_write:X` where the second write's content hash matches the pre-first-write state. Requires file content tracking in args. | "Plan more thoroughly before editing." |

#### Planning waste

| Pattern | Detection heuristic | Recommendation |
|---------|-------------------|----------------|
| `scattered_edits` | 3+ `file_write` spans targeting the same file within one turn, each separated by `thinking` spans. | "Plan all changes in one pass, apply in a single edit." |
| `late_discovery` | A `file_read` or `search` span in turn N ≥ 3 has `args.discovery = true` or introduces a frame not seen before, AND subsequent spans show a change in approach (different files being edited than turns 1-2). | "Explore broadly before committing to an approach." |
| `serial_independent` | 2+ consecutive tool_call spans where none references output from the prior one (no data dependency), and they could theoretically execute in parallel or be batched. | "Batch independent operations." |

### 5.2 Detection engine architecture

```
Profile
  ↓
┌─────────────────────────┐
│ Pattern detector runner  │
│                         │
│ For each pattern:       │
│   1. Select candidate   │
│      spans (by kind,    │
│      by frame prefix)   │
│   2. Run heuristic      │
│   3. If matched:        │
│      - Create           │
│        DetectedPattern  │
│      - Attach to the    │
│        relevant span(s) │
│      - Compute savings  │
└─────────────────────────┘
  ↓
DetectedPattern[] attached to spans
```

Each pattern detector is a pure function: `(profile: Profile) => DetectedPattern[]`. Detectors are independent and can run in any order. Results are cached and invalidated if the profile changes (new spans added).

### 5.3 Extending the vocabulary

New patterns are added by implementing the detector function and registering the pattern name + recommendation. The naming convention is `snake_case`, descriptive of the waste rather than the fix. The name should be self-explanatory when the LLM reads it as a token.

---

## 6. Export transforms

### 6.1 To speedscope

The speedscope format supports both evented and sampled profiles. Our export strategy:

**Spans → evented profiles:**
- One evented profile per (lane, dimension) combination.
- Profile name: `"{lane.name} — {value_type.description}"`.
- Each span becomes an open event at `start_time` and a close event at `end_time`, with `at` values set relative to the profile's `startValue`.
- The `frame` index in the event references `shared.frames[]`.
- Profile `unit` comes from the `ValueType.unit`.

**Samples → sampled profiles:**
- One sampled profile per (lane, dimension) combination.
- `samples[]` = array of frame-index stacks.
- `weights[]` = the value for the chosen dimension.

**When `include_idle = false`:** Filter out spans where `frame.name` starts with `user_input:` before generating events.

**When `include_idle = true`:** Generate an additional set of profiles with `"(with idle)"` suffix in the name.

The `shared.frames[]` array is built from `Profile.frames[]` with direct field mapping.

### 6.2 To Chrome Trace Event Format

- Each span → one `X` (complete) event: `{ ph: "X", name: frame.name, cat: category.name, ts: start_time * 1000 (μs), dur: (end_time - start_time) * 1000, pid: lane.pid || 1, tid: lane.tid || lane_index, args: span.args }`.
- Each marker → one `i` (instant) event: `{ ph: "i", name: marker.name, ts: marker.timestamp * 1000, s: "t" (thread scope) }`.
- Lane metadata → `M` events: `{ ph: "M", name: "thread_name", pid, tid, args: { name: lane.name } }`.
- Samples have no Chrome trace equivalent (Chrome trace is event-based). Samples from aggregate-only imports cannot be exported to Chrome trace; warn and skip.

### 6.3 To Gecko profile

- Each lane → a thread in the Gecko format.
- Spans → markers with `startTime` and `endTime`.
- Samples → the columnar `samples` table (stackTable prefix-tree encoding, frameTable, funcTable, stringTable).
- Categories → `meta.categories[]`.
- Frame table → funcTable + frameTable + stringTable.

### 6.4 To pprof

- Spans are synthesized into samples: each span generates one sample whose stack is the span's ancestor chain (root to leaf). Values are the span's `values[]`.
- If the profile already has Samples, they are written directly.
- `Profile.value_types[]` → `sample_type[]` + `value_unit[]` in the protobuf.
- Frame → Location → Function mapping with string table deduplication.
- Output is gzip-compressed protobuf.

### 6.5 To collapsed stacks

- Each span's ancestor chain (root to leaf) → one semicolon-delimited line.
- Weight = the first specified dimension's value for that span (or `wall_ms` by default).
- Each sample's stack → one line. Weight = the first dimension's value.
- Frame names used as-is.

---

## 7. MCP server implementation

### 7.1 Transport

Stdio transport for local Claude Code integration. The server is spawned as a subprocess and communicates over stdin/stdout via JSON-RPC per the MCP spec.

### 7.2 Server structure

```
mcp-profiler/
├── src/
│   ├── server.ts           # MCP server setup, tool registration
│   ├── model/
│   │   ├── types.ts         # Canonical data model interfaces (Section 2)
│   │   ├── profile.ts       # Profile construction and manipulation
│   │   └── frame-table.ts   # Deduplicated frame registry
│   ├── importers/
│   │   ├── detect.ts        # Format auto-detection
│   │   ├── pprof.ts         # pprof importer
│   │   ├── collapsed.ts     # Collapsed stacks importer
│   │   ├── chrome-trace.ts  # Chrome Trace Event importer
│   │   ├── gecko.ts         # Gecko profile importer
│   │   └── speedscope.ts    # Speedscope format importer
│   ├── exporters/
│   │   ├── speedscope.ts    # Speedscope exporter
│   │   ├── chrome-trace.ts  # Chrome trace exporter
│   │   ├── gecko.ts         # Gecko profile exporter
│   │   ├── pprof.ts         # pprof exporter
│   │   └── collapsed.ts     # Collapsed stacks exporter
│   ├── analysis/
│   │   ├── summary.ts       # profile_summary implementation
│   │   ├── hotspots.ts      # hotspots implementation
│   │   ├── explain.ts       # explain_span implementation
│   │   ├── waste.ts         # find_waste implementation
│   │   ├── token-flow.ts    # token_flow implementation
│   │   └── compare.ts       # compare implementation
│   ├── patterns/
│   │   ├── registry.ts      # Pattern detector registration
│   │   ├── redundant-read.ts
│   │   ├── large-context-small-edit.ts
│   │   ├── context-inflation.ts
│   │   ├── unused-output.ts
│   │   ├── retry-loop.ts
│   │   ├── full-suite-single-change.ts
│   │   ├── blind-edit.ts
│   │   ├── reverted-work.ts
│   │   ├── scattered-edits.ts
│   │   ├── late-discovery.ts
│   │   └── serial-independent.ts
│   └── instrument/
│       ├── trace.ts          # trace tool: implicit stack management
│       └── mark.ts           # mark tool: instant annotations
├── package.json
├── tsconfig.json
└── README.md
```

### 7.3 State management

The server holds in-memory state:

```typescript
class ProfilerState {
  /** The active profile being built/analyzed. */
  profile: Profile | null;
  
  /** Additional imported profiles (for compare). */
  imported: Map<string, Profile>;
  
  /** The implicit span stack for the trace tool. One stack per lane. */
  span_stacks: Map<string, string[]>; // lane_id → [span_id, span_id, ...]
  
  /** The active lane for instrumentation (defaults to "main"). */
  active_lane_id: string;
  
  /** Cached pattern detection results. Invalidated on profile mutation. */
  pattern_cache: DetectedPattern[] | null;
  
  /** Auto-incrementing ID counters. */
  next_span_id: number;
  next_marker_id: number;
}
```

### 7.4 Tool registration

Each tool is registered with the MCP SDK's `server.registerTool()`:

```typescript
server.registerTool("trace", {
  description: "Mark the start or end of a unit of work. Use this to instrument your own operations while you work: thinking, tool calls, file reads, bash commands, test runs. Call with action 'begin' before starting, 'end' when done. Cost data (tokens, time, bytes) goes on the 'end' call. Nesting is automatic — if you begin 'bash' while 'turn' is open, it nests correctly.",
  inputSchema: z.object({
    action: z.enum(["begin", "end"]),
    kind: z.string(),
    name: z.string().optional(),
    cost: z.record(z.number()).optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
}, async (input) => { /* ... */ });
```

Tool descriptions must be written exactly as specified in Section 4.2. The wording is load-bearing — it determines how the LLM reasons about when to use each tool.

### 7.5 Initialization

On server start:
1. Create empty `ProfilerState` with a default profile containing the LLM value types (Section 2.3).
2. Create a default "main" lane.
3. Register all tools.
4. Begin accepting MCP messages over stdio.

No configuration files. No environment variables. The server is immediately ready.

---

## 8. MCP prompts

The server exposes MCP prompt templates for structured analysis workflows.

### `performance_review`

A step-by-step analysis that an LLM can invoke after completing a task:

```
You just completed a task. Let's review your performance.

1. Call profile_summary with group_by="kind" to get the headline numbers.
2. Look at which group has the highest pct_of_total on any dimension.
3. Call hotspots on that dimension to find the most expensive spans.
4. For the top 3 hotspots, call explain_span to understand why they're expensive.
5. Call find_waste to identify work that didn't contribute to the result.
6. Synthesize your findings into:
   - What went well (efficient operations)
   - What was wasteful (with specific anti-patterns)
   - What to do differently next time (concrete recommendations)
```

### `optimize_for`

A targeted analysis for a specific dimension:

```
Optimize for: {dimension}

1. Call hotspots with dimension="{dimension}" and top_n=5.
2. For each hotspot, call explain_span.
3. Call find_waste.
4. Produce a ranked list of optimizations, ordered by expected savings on {dimension}.
```

---

## 9. Testing strategy

### Unit tests
- Each importer: parse a known-good file, assert the canonical model structure (frame count, lane count, sample/span counts, value dimensions).
- Each exporter: build a canonical model programmatically, export, re-import, and assert round-trip fidelity (within the format's expressiveness limits).
- Each pattern detector: construct a minimal Profile with the anti-pattern present, assert detection. Construct one without, assert no false positive.
- The trace tool: assert correct span stacking, auto-nesting, and graceful handling of mismatched begin/end.

### Integration tests
- Import a real speedscope sample file → run profile_summary → assert reasonable numbers.
- Import a Chrome trace from a real `chrome://tracing` export → export to speedscope → open in speedscope and verify visually (manual).
- Run the full performance_review prompt workflow against a synthetic profile with known waste patterns → assert all patterns detected and recommendations present.

### Test fixtures
- `fixtures/pprof/cpu.pb.gz` — a real Go CPU profile.
- `fixtures/collapsed/simple.txt` — the example from Brendan Gregg's docs.
- `fixtures/chrome-trace/simple.json` — a minimal B/E event trace.
- `fixtures/gecko/simple.json` — a minimal Gecko profile with samples + markers.
- `fixtures/speedscope/simple.speedscope.json` — from the speedscope repo's samples.

---

## 10. Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "zod": "^3.25",
    "pako": "^2.1"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.7",
    "vitest": "^3"
  }
}
```

- `@modelcontextprotocol/sdk` — MCP server framework with stdio transport.
- `zod` — Input schema validation (required peer dep of the MCP SDK).
- `pako` — gzip decompression for pprof protobuf files.
- No protobuf library: pprof protobuf parsing implemented manually (the schema is stable and small — ~15 message types). This avoids a heavy protobuf dependency.

---

## 11. Open design notes

**Host-side instrumentation.** In Claude Code, the host process knows when tool calls start/end, when thinking begins, and token counts. Ideally the host sends these events to the MCP server automatically, so the model only uses `trace` for custom semantic annotations. This requires a convention for the host to call `trace` on the model's behalf — or a separate "event push" mechanism. For v1, the model self-instruments.

**Parallel tool calls.** When Claude Code executes multiple tool calls concurrently, they should appear as parallel spans on separate lanes (or overlapping spans on the same lane). The `trace` tool's implicit stack doesn't handle true parallelism — concurrent begins would interleave. For v1, assume sequential execution. For v2, add a `lane` parameter to `trace` to support concurrent tracks.

**Token counting accuracy.** The model may not have precise token counts for its own thinking. `cost.input_tokens` on a thinking span may be an estimate. This is acceptable — the relative magnitudes matter more than exact counts for identifying waste patterns.

**Pattern detector extensibility.** Users should be able to add custom patterns without modifying the server code. For v2, consider a pattern definition format (JSON or simple DSL) that the server loads at startup from a config directory.
