# tracemeld roadmap: export fidelity, project-level baselines, and MCP messaging

This document describes the path from tracemeld's current state (v0.1.1, 44 commits) to a cohesive next milestone. The three workstreams — export format completeness, project-level semantic profiling history, and MCP messaging improvements — are designed to compound: exports produce the baseline files, baselines enable diff comparison, and messaging improvements make the diff results actionable.

## References

### Tracemeld codebase
- **Repository**: https://github.com/fnordpig/tracemeld (main branch)
- **Canonical model**: `src/model/types.ts` — Profile, Lane, Span, Sample, Marker, Frame, ValueType
- **Current exporters**: `src/exporters/collapsed.ts` (the only exporter)
- **Current importers**: `src/importers/` — pprof, chrome-trace, collapsed, gecko, nsight-sqlite
- **Current analysis tools**: `src/analysis/` — summary, hotspots, hotpaths, bottleneck, spinpaths, starvations, focus-function, explain, waste, query utilities
- **State management**: `src/model/state.ts` — ProfilerState with ProfileBuilder, PatternRegistry, implicit span stacks
- **Server/tool registration**: `src/server.ts` — 14 tools, 2 prompts, 1 resource
- **Design spec**: `design.md` — original architecture document

### Differential flamegraph algorithm references
- **Gregg's blog post explaining the technique**: https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html
- **`difffolded.pl` source (115 lines, the canonical implementation)**: https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl
- **`flamegraph.pl` source (handles two-column diff input, computes percentage)**: https://github.com/brendangregg/FlameGraph/blob/master/flamegraph.pl
- **Issue #170 — percentage formula documentation** (`(new-old)/new` not `(new-old)/old`): https://github.com/brendangregg/FlameGraph/issues/170
- **Gregg's Flame Graphs overview page**: https://www.brendangregg.com/flamegraphs.html
- **Gregg's ACM Queue article \"The Flame Graph\"**: https://queue.acm.org/detail.cfm?id=2927301
- **Gregg's YOW 2022 slides on differential flamegraphs (slide 74)**: https://www.brendangregg.com/Slides/YOW2022_flame_graphs/
- **Gregg's CPI Flame Graphs post (difffolded.pl with `-n` normalization for comparing different counter types)**: https://www.brendangregg.com/blog/2014-10-31/cpi-flame-graphs.html

### Bezemer's flamegraphdiff (triple-view differential)
- **`flamegraphdiff` tool**: https://corpaul.github.io/flamegraphdiff/
- **Live demo (Dispersy)**: http://corpaul.github.io/flamegraphdiff/demos/dispersy/dfg-set.html
- **SANER 2015 paper PDF**: http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf
- **IEEE entry**: http://ieeexplore.ieee.org/xpl/articleDetails.jsp?arnumber=7081872
- **SANER 2015 slide deck**: https://www.slideshare.net/corpaulbezemer/saner-2015-era-track

### FBDetect (Meta's subroutine-level regression detection)
- **Paper PDF (SOSP 2024)**: https://tangchq74.github.io/FBDetect-SOSP24.pdf
- **ACM Digital Library entry**: https://dl.acm.org/doi/10.1145/3694715.3695977
- **Extended version (ACM TOCS 2025, combined with ServiceLab)**: https://dl.acm.org/doi/pdf/10.1145/3785504
- **SOSP 2024 accepted papers list**: https://sigops.org/s/conferences/sosp/2024/accepted.html

### Export format specifications
- **Speedscope file format spec (TypeScript source)**: https://github.com/jlfwong/speedscope/blob/main/src/lib/file-format-spec.ts
- **Speedscope JSON schema**: https://www.speedscope.app/file-format-schema.json
- **Chrome Trace Event Format (Google Doc)**: https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview
- **pprof protobuf spec**: https://github.com/google/pprof/blob/main/proto/profile.proto
- **Gecko profile format documentation**: https://github.com/firefox-devtools/profiler/blob/main/docs-developer/gecko-profile-format.md

### MCP protocol references
- **MCP tool annotations spec (readOnlyHint, destructiveHint, etc.)**: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- **MCP sampling spec (server-initiated LLM reasoning)**: https://modelcontextprotocol.io/specification/draft/client/sampling
- **MCP elicitation spec (interactive forms)**: https://modelcontextprotocol.io/specification/draft/client/elicitation
- **SEP-1577 — Sampling With Tools proposal**: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577
- **MCP tasks (async long-running operations)**: https://deepwiki.com/modelcontextprotocol/modelcontextprotocol/2.7-task-system-and-async-operations

### Competitive references
- **CodSpeed MCP server announcement (March 16, 2026)**: https://codspeed.io/changelog/2026-03-16-mcp-server
- **Perfetto Trace Processor (SQL-over-traces)**: https://perfetto.dev/docs/analysis/trace-processor
- **PerfettoSQL standard library**: https://perfetto.dev/docs/analysis/stdlib-docs

---

## Workstream 1: Export format completeness

### Current state

The `export_profile` tool (`src/server.ts:219-260`) supports only `collapsed` format via `src/exporters/collapsed.ts`. The collapsed format loses all timing information, all metadata, all multi-dimensional values (only one dimension is exported as the weight), and all lane/thread structure. It's adequate for generating flamegraphs but insufficient as a round-trip format or as a baseline storage format.

The `export_profile` tool's `format` enum is currently `z.enum(['collapsed'])`. The design.md spec calls for speedscope, chrome_trace, gecko, pprof, and collapsed.

### What needs to exist

Three new exporters, in priority order, each serving a distinct purpose in the overall system:

#### 1.1 Speedscope exporter (`src/exporters/speedscope.ts`)

**Purpose**: The primary visual inspection format. When the agent says \"I've exported the profile — open it at speedscope.app to see the flamegraph,\" this is the file it produces. Also the richest JSON-based export, preserving multi-profile structure and frame metadata.

**Output format**: JSON conforming to `https://www.speedscope.app/file-format-schema.json`. The file-format-spec.ts at https://github.com/jlfwong/speedscope/blob/main/src/lib/file-format-spec.ts defines two profile types: `EventedProfile` (open/close events on a timeline) and `SampledProfile` (stacks with weights).

**Mapping from canonical model**:

Spans map to evented profiles. For each (lane, value_type) combination, generate one `EventedProfile`. Each span in the lane becomes a pair of events: `{ type: 'O', at: span.start_time, frame: span.frame_index }` and `{ type: 'C', at: span.end_time, frame: span.frame_index }`. Events must be sorted by `at` value. The profile's `unit` comes from `ValueType.unit`. The profile `name` is `\"{lane.name} — {value_type.description}\"`.

Samples map to sampled profiles. For each (lane, value_type) combination where the lane has samples, generate one `SampledProfile`. Each sample's `stack` (array of frame indices) maps directly to the speedscope `samples` array. The sample's value for that dimension maps to the `weights` array.

The `shared.frames` array is built from `Profile.frames[]` with direct field mapping: `{ name, file?, line?, col? }`.

The `$schema` field must be present and set to `\"https://www.speedscope.app/file-format-schema.json\"`. The `exporter` field should be `\"tracemeld@{version}\"`. The `name` field uses `Profile.name`. The `activeProfileIndex` defaults to 0.

**Multi-dimensional handling**: One speedscope file can contain multiple profiles. For a profile with 2 lanes and 3 value_types, this produces up to 6 profiles in the speedscope file. The user switches between them using speedscope's profile selector (n/p keys). Profile names include the dimension for disambiguation.

**Idle span filtering**: When the caller requests `include_idle: false` (the default for LLM agent profiles), filter out spans where the frame name starts with `user_input:` before generating events.

**Validation**: After generating the JSON, verify: all frame indices in events reference valid entries in `shared.frames`, all O/C events are balanced per-profile, events are sorted by `at` value, `samples` and `weights` arrays have equal length in sampled profiles.

**File**: `src/exporters/speedscope.ts`
**Test**: `src/exporters/speedscope.test.ts` — round-trip test: build a Profile programmatically, export to speedscope JSON, re-import via the speedscope importer (currently listed as unimplemented in `src/importers/import.ts:54`), verify structural equivalence. Also test with a real imported Chrome trace to verify cross-format fidelity.

#### 1.2 Chrome Trace Event exporter (`src/exporters/chrome-trace.ts`)

**Purpose**: The primary format for viewing in Perfetto UI (https://ui.perfetto.dev) and chrome://tracing. Best for timeline views with multi-lane parallel execution — GPU profiles, multi-threaded traces, agent sessions with concurrent tool calls.

**Output format**: JSON object `{ \"traceEvents\": [...] }`. Each event has `ph` (phase), `ts` (timestamp in **microseconds**), `pid`, `tid`, `name`, `cat`, `args`.

**Mapping from canonical model**:

Each span becomes one `X` (complete) event: `{ ph: \"X\", name: frame.name, cat: frame.category ?? \"default\", ts: span.start_time * 1000, dur: (span.end_time - span.start_time) * 1000, pid: lane.pid ?? lane_index, tid: lane.tid ?? 0, args: { ...span.args, values: valuesToRecord(span.values) } }`. The `args` bag carries the multi-dimensional values since Chrome trace has no native multi-value support.

Each marker becomes one `i` (instant) event: `{ ph: \"i\", name: marker.name, ts: marker.timestamp * 1000, pid, tid, s: \"t\", args: marker.data }`.

Lane metadata becomes `M` events: `{ ph: \"M\", name: \"thread_name\", pid, tid, args: { name: lane.name } }` and `{ ph: \"M\", name: \"process_name\", pid, args: { name: lane.name } }`.

Samples have no direct Chrome trace equivalent. For sampled profiles (e.g., imported pprof data), the exporter should either skip samples with a warning note, or synthesize `X` events from the stack with the sample's weight as duration (lossy but viewable).

**Timestamp precision**: The canonical model uses milliseconds. Chrome trace uses microseconds. Multiply by 1000. Do not truncate — sub-millisecond precision from imported Chrome traces should survive the round trip.

**File**: `src/exporters/chrome-trace.ts`
**Test**: `src/exporters/chrome-trace.test.ts` — import a Chrome trace fixture, export back to Chrome trace, verify event count and timestamp fidelity. Test multi-lane profiles produce correct pid/tid assignments.

#### 1.3 Baseline digest format (`src/exporters/baseline.ts`)

**Purpose**: A compact, semantically tagged profile digest designed for storage in project repositories and for diff comparison. This is NOT a standard external format — it's tracemeld's own format, optimized for the baseline checkpoint and diff workflow.

**Design principles**: Small enough to commit to git (target: <50KB for a typical profile). Contains enough information for meaningful diff analysis. Includes semantic metadata that the agent attaches at checkpoint time. Self-describing (includes value_type schema, categories, format provenance).

**Schema**:

```typescript
interface BaselineDigest {
  /** Format version for forward compatibility. */
  version: 1;
  
  /** tracemeld version that produced this baseline. */
  exporter: string;
  
  /** When the baseline was captured. */
  created_at: number;
  
  /** Agent-supplied semantic tags. */
  tags: {
    /** What this checkpoint represents: \"before\", \"after\", \"baseline\", \"regression\", \"optimization\" */
    checkpoint: string;
    /** Human-readable description of the task or change. */
    task?: string;
    /** Git commit hash at time of capture, if available. */
    commit?: string;
    /** Arbitrary key-value metadata the agent wants to record. */
    [key: string]: unknown;
  };
  
  /** Value type schema — what dimensions are measured. */
  value_types: ValueType[];
  
  /** Source format provenance chain: what was imported to produce this profile. */
  source_formats: string[];
  
  /** Headline totals across all dimensions. */
  totals: Record<string, number>;
  
  /** Per-kind breakdown (same as profile_summary group_by=\"kind\"). */
  kind_breakdown: {
    kind: string;
    totals: Record<string, number>;
    span_count: number;
    error_count: number;
  }[];
  
  /** Per-frame aggregated cost — the data needed for differential flamegraph computation.
      This is the collapsed-stack representation with multi-dimensional values.
      Keyed by semicolon-joined frame ancestry (root;parent;child), values are per-dimension totals. */
  frame_costs: {
    stack: string;
    self_cost: number[];
    total_cost: number[];
    call_count: number;
  }[];
  
  /** Top N hotspots by each dimension, for quick comparison without full reanalysis. */
  hotspots: {
    dimension: string;
    entries: {
      name: string;
      self_cost: number;
      pct_of_total: number;
    }[];
  }[];
  
  /** Detected anti-patterns at time of capture. */
  patterns: {
    name: string;
    severity: string;
    description: string;
    count: number;
  }[];
  
  /** Summary statistics. */
  stats: {
    span_count: number;
    sample_count: number;
    frame_count: number;
    lane_count: number;
    error_count: number;
    wall_duration_ms: number;
  };
}
```

The `frame_costs` array is the key data structure for diff computation. Each entry is a unique stack path (like collapsed stacks) with full multi-dimensional cost vectors. This is what `diff_profile` operates on.

**File**: `src/exporters/baseline.ts`
**Test**: `src/exporters/baseline.test.ts` — generate a baseline from a known profile, verify all fields are populated, verify frame_costs are correct, verify size is under 50KB for a profile with 1000 spans.

---

## Workstream 2: Project-level semantic profiling history

### Current state

The `ProfilerState` in `src/model/state.ts` is ephemeral — it lives in memory for the duration of the MCP server process. There is no concept of a baseline, a checkpoint, or a comparison between profiles. The `imported` map (`state.imported`) holds additional profiles for potential comparison but is never persisted and has no tool that queries it.

The `export_profile` tool writes files but doesn't record what it wrote or why. The `import_profile` tool loads data but doesn't track provenance or checkpoint identity.

### What needs to exist

#### 2.1 `save_baseline` tool

**Purpose**: The agent calls this after completing a task (or before starting one) to snapshot the current profile as a named, semantically tagged baseline.

**Registration in `src/server.ts`**:

```typescript
server.registerTool('save_baseline', {
  description:
    \"Snapshot the current profile as a named baseline for future comparison. \" +
    \"Call this before and after optimizations to measure improvement. \" +
    \"The baseline is saved to the project's .tracemeld/baselines/ directory as a compact digest.\",
  inputSchema: {
    name: z.string().describe('Baseline name, e.g. \"auth-refactor-before\" or \"v2.1-release\"'),
    checkpoint: z.enum(['before', 'after', 'baseline', 'release', 'custom'])
      .describe('What this checkpoint represents in the optimization lifecycle'),
    task: z.string().optional().describe('Description of the task or change being measured'),
    commit: z.string().optional().describe('Git commit hash, if known'),
    tags: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
    output_dir: z.string().optional()
      .describe('Directory to save baseline. Default: .tracemeld/baselines/'),
  },
}, (args) => { /* ... */ });
```

**Behavior**: Generates a `BaselineDigest` from the current `state.builder.profile` using the baseline exporter. Writes it to `{output_dir}/{name}.baseline.json`. Returns the file path, digest size, and headline totals for immediate feedback.

The tool should use `profileSummary` and `findHotspots` internally to populate the digest's `kind_breakdown` and `hotspots` fields. The `frame_costs` array is built by iterating all spans and samples, computing their ancestry-chain keys (same as collapsed stacks export), and aggregating multi-dimensional costs.

**File operations**: The tool creates the output directory if it doesn't exist (`mkdirSync` with `{ recursive: true }`). The filename is sanitized (replace non-alphanumeric characters with hyphens). A `.tracemeld/baselines/` directory at project root is the convention.

#### 2.2 `list_baselines` tool

**Purpose**: Show the agent what baselines exist for the current project, so it can choose which one to compare against.

**Registration**:

```typescript
server.registerTool('list_baselines', {
  description:
    \"List available baselines in the project's .tracemeld/baselines/ directory. \" +
    \"Shows name, checkpoint type, creation date, task description, and headline totals. \" +
    \"Use this to find the right baseline for diff_profile comparison.\",
  inputSchema: {
    baselines_dir: z.string().optional()
      .describe('Directory to scan. Default: .tracemeld/baselines/'),
  },
}, (args) => { /* ... */ });
```

**Behavior**: Reads all `*.baseline.json` files from the directory. Parses each, extracts the summary fields (name, checkpoint, task, commit, created_at, totals, stats). Returns a sorted list (most recent first) with enough context for the agent to choose which baseline to diff against.

#### 2.3 `diff_profile` tool

**Purpose**: Compare the current profile (or a loaded baseline) against a stored baseline. This is the payoff tool — it answers \"did the optimization help?\" and \"what regressed?\"

**Registration**:

```typescript
server.registerTool('diff_profile', {
  description:
    \"Compare the current profile against a stored baseline. Shows what got faster, \" +
    \"what got slower, and by how much — across all cost dimensions. \" +
    \"Use after save_baseline to measure the impact of an optimization. \" +
    \"Identifies regressions even when the overall improved.\",
  inputSchema: {
    baseline: z.string().describe('Path to a .baseline.json file, or baseline name to resolve from .tracemeld/baselines/'),
    dimension: z.string().optional().describe('Primary dimension to rank diffs by. Default: first value type.'),
    min_delta_pct: z.number().optional().describe('Minimum percentage change to report. Default: 5.'),
  },
}, (args) => { /* ... */ });
```

**Algorithm** — derived from Brendan Gregg's `difffolded.pl` and `flamegraph.pl`, adapted for multi-dimensional profiling.

**Primary references for the implementer**:

- Gregg's blog post explaining differential flamegraphs: https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html
- The `difffolded.pl` source code (115 lines of Perl, the canonical implementation): https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl
- The `flamegraph.pl` source code (handles the two-column output and computes percentage display): https://github.com/brendangregg/FlameGraph/blob/master/flamegraph.pl
- GitHub Issue #170 documenting the percentage formula: https://github.com/brendangregg/FlameGraph/issues/170
- Gregg's Flame Graphs overview page: https://www.brendangregg.com/flamegraphs.html
- Gregg's ACM Queue article \"The Flame Graph\" (formal reference): https://queue.acm.org/detail.cfm?id=2927301
- Cor-Paul Bezemer's `flamegraphdiff` triple-view tool: https://corpaul.github.io/flamegraphdiff/
- Bezemer, Pouwelse, Gregg. \"Understanding software performance regressions using differential flame graphs.\" IEEE SANER 2015: http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf
- FBDetect paper (SOSP 2024) — subroutine-level regression detection at Meta: https://tangchq74.github.io/FBDetect-SOSP24.pdf
- FBDetect ACM DL entry: https://dl.acm.org/doi/10.1145/3694715.3695977
- FBDetect extended version (ACM TOCS 2025): https://dl.acm.org/doi/pdf/10.1145/3785504

**How `difffolded.pl` works** (this is the algorithm tracemeld must replicate):

The tool reads two collapsed-stack files. Each file has lines of the form `stack_frame_a;stack_frame_b;stack_frame_c COUNT`. The Perl source (https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl) does the following:

```
# Phase 1: Read file1 (before), accumulate per-stack counts and total
%Folded = {}
for each line in file1:
    (stack, count) = parse line
    Folded{stack}{1} += count
    total1 += count

# Phase 2: Read file2 (after), accumulate per-stack counts and total
for each line in file2:
    (stack, count) = parse line
    Folded{stack}{2} += count
    total2 += count

# Phase 3: Full outer join — emit every stack seen in either file
for each stack in keys(Folded):
    Folded{stack}{1} //= 0   # default missing stacks to 0
    Folded{stack}{2} //= 0

    # Normalize: scale file1 counts so totals match file2
    if normalize_flag and total1 != total2:
        Folded{stack}{1} = int(Folded{stack}{1} * total2 / total1)

    # Output: \"stack count1 count2\"
    print \"$stack $Folded{stack}{1} $Folded{stack}{2}\
\"
```

The output is a three-column format: `stack before_count after_count`. This is piped to `flamegraph.pl`, which draws the flame graph using the **second column** (after) for frame widths, and colors frames by the **delta** (after - before): red for growth, blue for reduction, saturation proportional to magnitude.

**The percentage formula controversy** (GitHub Issue #170, https://github.com/brendangregg/FlameGraph/issues/170): `flamegraph.pl` computes the displayed percentage as `(new - old) / new * 100`, NOT `(new - old) / old * 100`. This means a stack going from 6 to 7 samples shows `+14.29%` (1/7), not `+16.6%` (1/6). The denominator is the **after** profile because the frame widths are drawn from the after profile, so the percentage represents \"what fraction of the current width is attributable to the change.\" Tracemeld should implement BOTH formulas and let the caller choose via a `pct_base` parameter (`\"after\"` matching flamegraph.pl default, or `\"before\"` matching the more intuitive definition).

**Normalization** (`-n` flag): When comparing profiles from workloads of different duration or load, raw counts are misleading. The `-n` flag scales all of file1's counts by `total2 / total1`, making the totals equal. After normalization, a delta of 0 means \"same proportion of total work,\" not \"same absolute count.\" This is critical for tracemeld's use case: an agent's \"before\" session might be 30 seconds and the \"after\" might be 60 seconds. Without normalization, every stack would show as a regression. Tracemeld should **normalize by default** with an option to disable.

**Elided stacks**: Gregg documents a critical limitation: stacks that exist in the before profile but vanish entirely in the after profile have zero width and become invisible in the diff. The diff output includes them (count2 = 0), but the flamegraph visualization hides them. Tracemeld's text-based output doesn't have this problem — it can explicitly report vanished stacks in the `removed_stacks` array.

**Bezemer's triple-view** (https://corpaul.github.io/flamegraphdiff/, SANER 2015 paper: http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf): Shows three flame graphs side by side — before, after, and diff — with linked mouseover highlighting across all three. This solves the context problem. For tracemeld's text-based MCP output, the equivalent is returning the before and after summaries alongside the diff, so the LLM has all three views to reason about.

**FBDetect's subroutine-level gCPU technique** (paper: https://tangchq74.github.io/FBDetect-SOSP24.pdf, Section 3): FBDetect goes beyond simple before/after comparison with a statistically rigorous approach to regression detection. The key concepts tracemeld should borrow:

1. **gCPU metric**: For subroutine A, `gCPU_A = samples_containing_A / total_samples`. If 100 stack-trace samples are collected and subroutine A appears in 8 of them, `gCPU_A = 8%`. This is directly computable from tracemeld's collapsed-stack representation in the baseline digest's `frame_costs` array. Each frame's `total_cost / sum(all_total_costs)` is its gCPU.

2. **Variance reduction through granularity**: Measuring at process level, variance is high. At subroutine level, variance is reduced by a factor of ~k where k is the number of subroutines. FBDetect found k=12,048 for a typical Meta service (median gCPU = 0.0083%), enabling detection of 0.005% regressions. For tracemeld's LLM agent profiles, k is much smaller (dozens to hundreds of unique functions), but the principle still applies: per-function gCPU is a more stable metric than total session cost.

3. **Cost shift detection (false positive filter)**: If function B's gCPU increases but its parent function A's total gCPU is unchanged, the change is refactoring (code moved between functions), not a real regression. Tracemeld should implement this check: when reporting a regression in a child frame, verify that the parent frame's total cost also changed. If parent total cost is stable (delta < threshold), flag the child's change as `\"likely_refactoring\": true` rather than a true regression.

**Implementation steps for tracemeld's diff algorithm**:

1. Load the baseline digest from file. Validate `version` field for forward compatibility.
2. Generate a digest from the current profile (same `BaselineDigest` structure) using the same `exportBaseline()` function.
3. **Normalize**: Compute `norm_factor = total_after / total_before` for the primary dimension. Multiply all baseline `frame_costs[].self_cost[dim]` and `frame_costs[].total_cost[dim]` by `norm_factor`. This follows difffolded.pl's `-n` logic: `int(count1 * total2 / total1)`.
4. **Full outer join on frame_costs**: Build a `Map<string, { before: FrameCost | null, after: FrameCost | null }>` keyed by the `stack` string. Stacks present in only one side get null on the other.
5. **Compute deltas per stack per dimension**: For each stack entry: `delta = after_cost - before_cost`, `delta_pct_of_after = (after - before) / after * 100` (flamegraph.pl convention), `delta_pct_of_before = (after - before) / before * 100` (intuitive convention). Include both. Guard against division by zero when before=0 (new stack) or after=0 (removed stack).
6. **Apply cost shift filter**: For each regression, check whether the parent stack (stack minus the leaf frame) also regressed. If parent total cost delta is within ±2%, flag as `likely_refactoring`.
7. **Rank and filter**: Sort by absolute delta descending. Filter by `min_delta_pct` threshold (default 5%). Cap at top 15 regressions and top 15 improvements.
8. **Headline comparison**: Compare totals, kind_breakdown, patterns, and stats between the two digests.
9. **Regression warnings**: Any dimension where the total increased gets flagged, even if other dimensions improved.

**Return value** — structured for LLM reasoning:

```typescript
interface DiffResult {
  baseline_name: string;
  baseline_created_at: number;
  normalized: boolean;
  norm_factor?: number;
  
  /** Per-dimension headline deltas. */
  headline: Record<string, {
    before: number;
    after: number;
    delta: number;
    delta_pct: number;
  }>;
  
  /** Top regressions — stacks that got more expensive. */
  regressions: DiffEntry[];
  
  /** Top improvements — stacks that got cheaper. */
  improvements: DiffEntry[];
  
  /** New stacks not present in baseline. */
  new_stacks: DiffEntry[];
  
  /** Stacks that disappeared (were in baseline, not in current). */
  removed_stacks: DiffEntry[];
  
  /** Dimensions where total cost increased. */
  regression_warnings: { dimension: string; delta_pct: number; note: string }[];
  
  /** Pattern comparison: new patterns, resolved patterns. */
  pattern_diff: {
    new_patterns: string[];
    resolved_patterns: string[];
  };
}

interface DiffEntry {
  stack: string;
  name: string; // leaf frame name for readability
  before: Record<string, number>;
  after: Record<string, number>;
  delta: Record<string, number>;
  delta_pct: Record<string, number>;
}
```

**File**: `src/analysis/diff.ts` (the core algorithm), `src/analysis/diff.test.ts`
**The tool handler** in `src/server.ts` reads the baseline file, calls the diff function, and returns the structured result.

#### 2.4 Updated `performance_review` prompt

The existing `performance_review` prompt in `src/server.ts:356-382` should be extended to check for existing baselines and incorporate comparison when available. Add a step: \"If baselines exist in .tracemeld/baselines/, call list_baselines and diff_profile against the most relevant one.\"

#### 2.5 New `optimization_loop` prompt

A new prompt that encodes the full cycle we've discussed:

```
1. Call save_baseline with checkpoint=\"before\" and a descriptive task name.
2. Call profile_summary, bottleneck, and find_waste to identify optimization targets.
3. [Agent makes code changes based on findings]
4. [Agent re-runs the workload and re-imports the profile]
5. Call save_baseline with checkpoint=\"after\" using the same task name.
6. Call diff_profile against the \"before\" baseline.
7. Synthesize: what improved, what regressed, what's the net impact?
```

---

## Workstream 3: MCP messaging improvements

### Current state

Tool registrations in `src/server.ts` use the MCP SDK's `registerTool` with `description` and `inputSchema`. No tools declare `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint). Tool responses are all `{ content: [{ type: 'text', text: JSON.stringify(result) }] }` — plain JSON text with no structured content type differentiation. The server declares no capabilities beyond what `McpServer` defaults provide — no sampling, no elicitation.

### 3.1 Tool annotations

**Impact**: Clients that support annotations (Claude Code, Cursor, Windsurf) can auto-approve read-only, idempotent tools without user confirmation prompts. This removes friction from the analysis workflow — the agent can call `profile_summary → hotspots → explain_span → find_waste` in a chain without pausing for approval at each step.

**Implementation**: Add `annotations` to every `registerTool` call in `src/server.ts`:

Analysis tools (profile_summary, hotspots, hotpaths, bottleneck, spinpaths, starvations, focus_function, find_waste, explain_span, list_baselines, diff_profile, up_to_date):
```typescript
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
```

Instrumentation tools (trace, mark):
```typescript
annotations: {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
```

Import tool (import_profile):
```typescript
annotations: {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
```

Export/baseline tools (export_profile, save_baseline):
```typescript
annotations: {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,  // writes to filesystem
}
```

**Spec reference**: The `ToolAnnotations` type is defined at https://modelcontextprotocol.io/specification/2025-06-18/server/tools — see the \"Tool annotations\" section. The annotations object is part of the tool definition, alongside `name`, `description`, and `inputSchema`. Clients that support annotations (Claude Code, Cursor, Windsurf) use these hints to decide whether to auto-approve tool calls or prompt the user for confirmation.

**File changes**: `src/server.ts` only. Each `registerTool` call gets an `annotations` field added to its second argument.

### 3.2 Structured tool response improvements

**Current problem**: Every tool returns `JSON.stringify(result)` as a single text content block. For large results (hotspots with 10 entries, each with ancestry chains and pattern lists), this can be thousands of tokens. The LLM must parse the entire JSON blob to reason about it.

**Improvement 1 — Concise text summaries alongside structured data**: For key analysis tools, prepend a human-readable summary line before the JSON. This gives the LLM a quick signal without parsing the full structure.

For example, `hotspots` currently returns:
```json
{\"dimension\":\"wall_ms\",\"entries\":[{\"span_id\":\"s42\",\"name\":\"bash:npm test\",...},...]}
```

It should return a multi-content response:
```typescript
return {
  content: [
    {
      type: 'text' as const,
      text: `Top hotspot: bash:npm test (52% of wall_ms, self: 3,400ms). 3 anti-patterns detected.`,
    },
    {
      type: 'text' as const,
      text: JSON.stringify(result),
    },
  ],
};
```

The first content block is the headline the LLM reads immediately. The second is the full structured data it can drill into. This pattern should apply to: `profile_summary`, `hotspots`, `bottleneck`, `find_waste`, `diff_profile`, and `explain_span`.

**Improvement 2 — Response size awareness**: For profiles with many spans, tool responses can exceed useful token budgets. The `hotspots` tool already respects `top_n` (default 10). Other tools should similarly cap output. `explain_span`'s causal_chain should be limited to the 20 most significant events. `diff_profile`'s regressions and improvements should be capped at top 15 each. The `focus_function` callers and callees already respect `top_n`.

### 3.3 MCP sampling capability declaration (future-ready)

**What this enables**: MCP sampling lets the server ask the client's LLM to reason about data. The server sends a `sampling/createMessage` request with a system prompt and conversation context, and the client's LLM generates a response. This turns tracemeld from a data source into a reasoning partner — the server computes hotspots, then asks the LLM \"given these hotspots and the source code at these locations, what is the root cause?\"

**Current MCP SDK support**: The `@modelcontextprotocol/sdk` supports declaring `sampling` as a server capability. The `McpServer` constructor accepts a `capabilities` option. The sampling protocol (https://modelcontextprotocol.io/specification/draft/client/sampling) defines the `sampling/createMessage` request: the server sends `{ messages, systemPrompt?, modelPreferences?, maxTokens }` and the client returns `{ model, role: \"assistant\", content }`. The `modelPreferences` field lets the server request specific intelligence/speed tradeoffs. SEP-1577 (https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577) proposes extending sampling with tool use, enabling agentic loops within a single sampling request — tracemeld could eventually use this to let the LLM call back into tracemeld's analysis tools during a sampling session. However, Claude Code's MCP client support for sampling is still evolving. This should be implemented as a capability declaration now (so the server advertises it) with the actual sampling call-sites added when client support is confirmed.

**Implementation**:

Add to server constructor:
```typescript
const server = new McpServer({
  name: 'tracemeld',
  version: pkg.version,
}, {
  capabilities: {
    sampling: {},
  },
});
```

Create a helper in `src/messaging/sampling.ts` that wraps the sampling request pattern:
```typescript
export async function askLLM(
  server: McpServer,
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<string | null> {
  try {
    const result = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
      systemPrompt,
      maxTokens: options?.maxTokens ?? 1024,
    });
    return result.content.type === 'text' ? result.content.text : null;
  } catch {
    return null; // Client doesn't support sampling — degrade gracefully
  }
}
```

The key design principle: **every use of sampling must degrade gracefully**. If the client doesn't support sampling, the tool falls back to its current behavior (template-based recommendations). Sampling enhances but never gates functionality.

**First sampling use-case**: The `bottleneck` tool currently generates recommendations via the `generateRecommendation` function in `src/analysis/bottleneck.ts:108-120`, which uses a switch statement on the frame kind to produce generic advice (\"This command accounts for 72% of total cost. Consider scoping it more tightly.\"). With sampling, the tool could instead ask the LLM: \"Given that `bash:npm test` accounts for 72% of wall time, and the source is at `src/tests/run.ts:14`, what specific optimization would you recommend?\" The LLM's response replaces the template string. If sampling fails, the template is used as fallback.

### 3.4 Chrome trace importer: fix parent-child nesting

**This is a correctness bug**, not a messaging improvement, but it's prerequisite to meaningful exports and diffs. The current Chrome trace importer (`src/importers/chrome-trace.ts`) does not set `parent_id` on spans. All imported spans have `parent_id: null` regardless of their actual nesting in the trace.

**The fix**: Maintain a per-lane stack of currently-open span IDs. When a new span opens (B or X event), set its `parent_id` to the top of the stack, add it to the parent's `children` array, then push it onto the stack. When a span closes (E event or X event end), pop the stack.

For X (complete) events, the nesting is determined by containment: if span B starts after span A and ends before span A, B is a child of A. This requires sorting X events by start time, then using a stack-based sweep.

For B/E events, the nesting is already encoded in the event ordering — B events push onto the stack, E events pop. The current code maintains an `openSpans` stack per event name but doesn't use it for parenting.

**File**: `src/importers/chrome-trace.ts` — modify the B and X event handlers.
**Test**: `src/importers/chrome-trace.test.ts` — add a test with nested B/E events and verify parent_id and children[] are correctly set.

---

## Task decomposition

The following tasks are ordered by dependency. Tasks within the same phase can be executed in parallel.

### Phase 0: Correctness fix (prerequisite for meaningful exports)

**T0.1** — Fix Chrome trace parent-child nesting in `src/importers/chrome-trace.ts`. Add stack-based parenting for B/E and containment-based parenting for X events. Update tests.

### Phase 1: Export foundation (parallel with Phase 2 prep)

**T1.1** — Implement speedscope exporter (`src/exporters/speedscope.ts`). Handle evented profiles from spans, sampled profiles from samples, shared frame table, multi-dimensional profile generation. Write round-trip tests.

**T1.2** — Implement Chrome trace exporter (`src/exporters/chrome-trace.ts`). Handle span→X events, marker→i events, lane→M metadata events. Microsecond timestamp conversion. Write round-trip tests against Chrome trace importer.

**T1.3** — Wire new exporters into `export_profile` tool in `src/server.ts`. Expand format enum to `z.enum(['collapsed', 'speedscope', 'chrome_trace'])`. Add `include_idle` boolean parameter.

**T1.4** — Add MCP tool annotations to all existing tools in `src/server.ts`. No new logic, just annotations on every `registerTool` call.

### Phase 2: Baseline digest format (depends on nothing, parallel with Phase 1)

**T2.1** — Define baseline digest TypeScript interfaces in `src/exporters/baseline-types.ts`.

**T2.2** — Implement baseline digest generator (`src/exporters/baseline.ts`). Takes a Profile and semantic tags, produces a `BaselineDigest` by running summary, hotspots (top 10 per dimension), frame cost aggregation, and pattern detection. Write tests verifying all fields are populated and size constraints.

### Phase 3: Diff engine (depends on T2.2)

**T3.1** — Implement diff algorithm (`src/analysis/diff.ts`). Full outer join on frame_costs following the `difffolded.pl` algorithm (source: https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl), normalization via `count1 * total2 / total1`, dual percentage formulas (flamegraph.pl convention per https://github.com/brendangregg/FlameGraph/issues/170, and intuitive convention), FBDetect-inspired cost shift detection for false positive filtering (paper Section 3: https://tangchq74.github.io/FBDetect-SOSP24.pdf). Write tests with known-delta profiles.

### Phase 4: Baseline and diff tools (depends on T2.2, T3.1)

**T4.1** — Register `save_baseline` tool in `src/server.ts`. Wire to baseline exporter. Handle directory creation, file naming, tag attachment.

**T4.2** — Register `list_baselines` tool in `src/server.ts`. Scan directory, parse digest headers, return sorted list.

**T4.3** — Register `diff_profile` tool in `src/server.ts`. Load baseline, generate current digest, call diff algorithm, return structured result with headline summary.

**T4.4** — Add concise text summaries to analysis tool responses (profile_summary, hotspots, bottleneck, find_waste, diff_profile, explain_span) in `src/server.ts`. Each tool returns a headline text block before the JSON block.

### Phase 5: MCP capabilities and prompts (depends on T4.3)

**T5.1** — Add `optimization_loop` prompt to `src/server.ts`. References save_baseline, diff_profile, and the analysis tools in a step-by-step workflow.

**T5.2** — Update existing `performance_review` prompt to include baseline comparison when baselines are available.

**T5.3** — Declare sampling capability in McpServer constructor. Create `src/messaging/sampling.ts` helper with graceful degradation. Wire into `bottleneck` tool's recommendation generation as the first sampling call-site.

### Phase 6: Skill documentation (depends on T4.3)

**T6.1** — Write a `baseline-workflow` skill document for `docs/superpowers/plans/`. Teaches the agent how to use save_baseline, list_baselines, and diff_profile in practice. Includes examples for common scenarios: before/after optimization, CI regression checking, cross-session performance tracking.

---

## Dependency graph

```mermaid
graph TD
    subgraph \"Phase 0: Correctness\"
        T0_1[\"T0.1: Fix Chrome trace<br/>parent-child nesting<br/><i>src/importers/chrome-trace.ts</i>\"]
    end

    subgraph \"Phase 1: Export Foundation\"
        T1_1[\"T1.1: Speedscope exporter<br/><i>src/exporters/speedscope.ts</i>\"]
        T1_2[\"T1.2: Chrome trace exporter<br/><i>src/exporters/chrome-trace.ts</i>\"]
        T1_3[\"T1.3: Wire exporters into<br/>export_profile tool\"]
        T1_4[\"T1.4: Add MCP tool annotations<br/><i>src/server.ts</i>\"]
    end

    subgraph \"Phase 2: Baseline Format\"
        T2_1[\"T2.1: Baseline digest types<br/><i>src/exporters/baseline-types.ts</i>\"]
        T2_2[\"T2.2: Baseline digest generator<br/><i>src/exporters/baseline.ts</i>\"]
    end

    subgraph \"Phase 3: Diff Engine\"
        T3_1[\"T3.1: Diff algorithm<br/><i>src/analysis/diff.ts</i><br/>Full outer join + normalize + rank\"]
    end

    subgraph \"Phase 4: Tools & Messaging\"
        T4_1[\"T4.1: save_baseline tool\"]
        T4_2[\"T4.2: list_baselines tool\"]
        T4_3[\"T4.3: diff_profile tool\"]
        T4_4[\"T4.4: Concise text summaries<br/>on analysis tool responses\"]
    end

    subgraph \"Phase 5: MCP & Prompts\"
        T5_1[\"T5.1: optimization_loop prompt\"]
        T5_2[\"T5.2: Update performance_review<br/>prompt with baseline check\"]
        T5_3[\"T5.3: Sampling capability +<br/>bottleneck LLM recommendations\"]
    end

    subgraph \"Phase 6: Documentation\"
        T6_1[\"T6.1: baseline-workflow skill<br/><i>docs/superpowers/plans/</i>\"]
    end

    %% Dependencies
    T0_1 --> T1_2
    T1_1 --> T1_3
    T1_2 --> T1_3
    T2_1 --> T2_2
    T2_2 --> T3_1
    T2_2 --> T4_1
    T3_1 --> T4_3
    T4_1 --> T4_3
    T4_2 --> T4_3
    T4_3 --> T5_1
    T4_3 --> T5_2
    T4_3 --> T6_1
    T4_4 --> T5_3

    %% Parallel path annotations
    T1_4 -.->|\"independent, do anytime\"| T4_4
    T2_1 -.->|\"parallel with Phase 1\"| T1_1

    %% Milestone markers
    T1_3:::milestone
    T4_3:::milestone
    T5_1:::milestone

    classDef milestone fill:#E1F5EE,stroke:#0F6E56,stroke-width:2px
```

**Parallel execution paths**:

Path A (exports): T0.1 → T1.2 → T1.3 (Chrome trace chain); T1.1 → T1.3 (speedscope chain). These can proceed in parallel with Path B.

Path B (baselines): T2.1 → T2.2 → T3.1 → T4.3 (baseline → diff chain). Independent of Path A until the tools are wired.

Path C (messaging): T1.4 (annotations) and T4.4 (response summaries) are independent of each other and of the baseline chain. T5.3 (sampling) depends on T4.4 only because it modifies tool response structure.

**Milestones**:

After T1.3: tracemeld can export to speedscope and Chrome trace. The \"import → analyze → export → visualize\" workflow is complete.

After T4.3: tracemeld can save, list, and diff baselines. The \"checkpoint → optimize → compare\" workflow is complete.

After T5.1: the optimization_loop prompt encodes the full autonomous cycle. The agent has a single entry point that chains the entire workflow.

**Estimated effort per task** (for a single developer or Claude Code session):

- T0.1: ~30 minutes (small fix, well-scoped)
- T1.1: ~2 hours (medium complexity, well-specified by speedscope schema)
- T1.2: ~1.5 hours (simpler than speedscope, fewer edge cases)
- T1.3: ~30 minutes (wiring only)
- T1.4: ~15 minutes (add annotations to existing calls)
- T2.1: ~30 minutes (type definitions only)
- T2.2: ~2 hours (aggregation logic, reuses existing analysis functions)
- T3.1: ~3 hours (the most algorithmically complex task)
- T4.1: ~1 hour (file I/O + tool registration)
- T4.2: ~45 minutes (directory scan + parse)
- T4.3: ~1.5 hours (tool registration + response formatting)
- T4.4: ~1 hour (add summary lines to 6 tools)
- T5.1: ~30 minutes (prompt template)
- T5.2: ~30 minutes (prompt update)
- T5.3: ~2 hours (sampling helper + bottleneck integration + graceful degradation)
- T6.1: ~1 hour (skill documentation)

**Total**: approximately 17-18 hours of implementation work.

