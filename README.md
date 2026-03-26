# tracemeld

A stateless [MCP](https://modelcontextprotocol.io) server for performance profiling and analysis. Import profiles from standard formats, instrument live sessions, run analysis queries, and export to visualization tools — all through tool calls.

Built for LLM agents that need to reason about where time and resources go. Also useful as a general-purpose profile analysis backend for any MCP client.

## Install

```
npm install -g tracemeld
```

Or add it to your MCP client config:

```json
{
  "mcpServers": {
    "tracemeld": {
      "command": "npx",
      "args": ["-y", "tracemeld"]
    }
  }
}
```

## What it does

Tracemeld holds a single in-memory profile per session. You either build one up through live instrumentation (`trace`, `mark`) or load one from a file (`import_profile`). Then you query it.

### Importers

Reads these formats, auto-detected from content:

| Format | Source |
|---|---|
| **pprof** | Go, Rust (pprof-rs), any protobuf pprof producer |
| **Collapsed stacks** | `perf script \| stackcollapse-perf.pl`, Brendan Gregg tools |
| **Chrome Trace Events** | Chrome DevTools, Perfetto, `chrome://tracing` |
| **Gecko Profile** | Firefox Profiler, [samply](https://github.com/mstange/samply) |
| **V8 .cpuprofile** | Node.js `--cpu-prof`, Chrome DevTools CPU profiler |
| **NVIDIA Nsight Systems** | `.nsys-rep` SQLite exports (CUDA kernel timelines) |
| **Claude Code transcripts** | `.jsonl` session transcripts from Claude Code |

Gzip-compressed inputs are handled transparently. Gecko profiles with samply `.syms.json` sidecars are auto-resolved.

### Analysis tools

All analysis is read-only against the loaded profile.

| Tool | Purpose |
|---|---|
| `profile_summary` | Headline numbers: total time, tokens, cost, errors. Group by kind, turn, or lane. |
| `hotspots` | Rank operations by any cost dimension. Returns ancestry chains. |
| `hotpaths` | Critical root-to-leaf call paths, ranked by total cost. |
| `bottleneck` | Combines self-cost with path criticality to find the highest-leverage optimization targets. |
| `explain_span` | Deep-dive into one span: child breakdown, causal chain, detected anti-patterns. |
| `find_waste` | Identify retries, unused reads, blind edits — work that didn't contribute to the result. |
| `focus_function` | Caller/callee breakdown for a single function in the call graph. |
| `spinpaths` | High wall-time spans with low useful output (busy-waiting, spinning). |
| `starvations` | Idle lanes while others are active (lock contention, serialization). |

### Anti-pattern detection

Built-in heuristics detect common LLM agent waste patterns:

- **Blind edits** — editing a file without reading it first
- **Redundant reads** — reading the same file multiple times in a span
- **Retry loops** — repeated failed attempts at the same operation

These surface automatically in `hotspots`, `explain_span`, and `find_waste` results.

### Baselines and diffing

Save profile snapshots as baselines, then diff against them to measure optimization impact:

```
save_baseline → [make changes] → re-profile → diff_profile
```

Diffs report per-function regressions and improvements across all cost dimensions. Normalization handles profiles of different total duration.

### Exporters

Export the loaded profile to standard visualization formats:

| Format | Opens in |
|---|---|
| **Collapsed stacks** | [flamegraph.pl](https://github.com/brendangregg/FlameGraph), Inferno |
| **Speedscope** | [speedscope.app](https://speedscope.app) |
| **Chrome Trace Events** | [Perfetto UI](https://ui.perfetto.dev), `chrome://tracing` |

### Live instrumentation

For LLM agents profiling their own sessions:

- `trace` — begin/end spans around units of work (tool calls, thinking, file operations)
- `mark` — instant annotations (test failures, decision points, context pressure)

Nesting is automatic. Cost data (tokens, time, bytes) attaches to the `end` call.

## Data model

Everything normalizes into a single `Profile`:

- **Frames** — deduplicated function/operation identifiers (`{kind}:{detail}` naming convention)
- **Spans** — timed intervals referencing frames, with parent/child relationships
- **Samples** — stack snapshots at points in time (from sampling profilers)
- **Markers** — instant annotations on the timeline
- **Lanes** — execution tracks (threads, processes, agent tracks)
- **Value types** — multi-dimensional cost: wall time, tokens, dollars, bytes — all measured simultaneously

## Development

```bash
npm run build          # TypeScript compilation
npm run dev            # Watch mode
npm run test           # 293 tests across 35 suites
npm run lint           # ESLint strict-type-checked
npm run inspect        # Build + open MCP Inspector
```

### Source layout

```
src/
  model/         Profile, Frame, Span, Sample, Marker, ProfileBuilder, FrameTable
  instrument/    trace and mark tool handlers
  analysis/      profile_summary, hotspots, hotpaths, bottleneck, explain_span, etc.
  importers/     pprof, collapsed, chrome-trace, gecko, v8-cpuprofile, nsight-sqlite, claude-transcript
  exporters/     collapsed, speedscope, chrome-trace, baseline
  patterns/      Anti-pattern detection (blind-edit, redundant-read, retry-loop)
  server.ts      MCP server setup and tool registration
```

All tool handlers are pure functions: `(state, input) => result`. Tests mirror source paths.

## License

MIT
