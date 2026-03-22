# Competitive Landscape Reference for Tracemeld

Reference distillation for the tracemeld roadmap. Parent planning document:
`docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`

---

## 1. CodSpeed MCP Server

**Source**: https://codspeed.io/changelog/2026-03-16-mcp-server (announced March 16, 2026)

CodSpeed is a CI/CD performance benchmarking platform with GitHub integration. Its MCP server exposes tools for querying benchmark history, comparing runs across commits, and detecting performance regressions in CI pipelines. CodSpeed measures the performance impact of pull requests automatically.

**Key differentiator from tracemeld**: CodSpeed operates at CI time on code changes; tracemeld operates at development time on LLM agent sessions. CodSpeed answers "did this PR make things slower?" while tracemeld answers "why is this agent session slow?"

---

## 2. Perfetto Trace Processor

**Source**: https://perfetto.dev/docs/analysis/trace-processor

Perfetto's Trace Processor is a SQL-over-traces engine that loads trace files into an in-memory SQLite database. It supports Chrome traces, Android systrace, Linux ftrace, and the Perfetto native format.

### Key SQL Tables

| Table | Contents |
|-------|----------|
| `slice` | Spans/events with `ts`, `dur`, `name`, `track_id` |
| `thread_track` | Per-thread timelines |
| `process_track` | Per-process timelines |
| `counter` | Continuous time-varying values |
| `thread` | Thread metadata |
| `process` | Process metadata |
| `args` | Key-value properties attached to events |

### Query Interface

```
trace_processor trace.perfetto-trace --query "SELECT name, dur FROM slice ORDER BY dur DESC LIMIT 10"
```

A WASM-based web UI at https://ui.perfetto.dev provides interactive exploration. Extremely powerful for ad-hoc analysis but requires SQL knowledge.

---

## 3. PerfettoSQL Standard Library

**Source**: https://perfetto.dev/docs/analysis/stdlib-docs

The stdlib provides pre-built analysis functions organized into modules: `android`, `chrome`, `linux`, `wattson` (power), and others. It includes table functions like `ANDROID_SLICES()`, `THREAD_SLICE()`, and macros for common patterns.

The stdlib demonstrates the value of domain-specific abstractions on top of raw trace data. Tracemeld's opinionated analysis tools (`hotspots`, `bottleneck`, `find_waste`) serve the same purpose as PerfettoSQL's stdlib -- providing ready-made analysis patterns so users do not need to write queries from scratch.

---

## 4. Competitive Positioning Matrix

| Capability | Tracemeld | CodSpeed MCP | Perfetto |
|---|---|---|---|
| Interface | MCP tools | MCP tools | SQL + GUI |
| Primary use case | LLM agent profiling | CI/CD benchmarking | System trace analysis |
| Query model | Opinionated analysis tools | Benchmark comparison | Arbitrary SQL |
| Baseline/diff | Yes (planned) | Yes (CI-native) | Manual SQL queries |
| Anti-pattern detection | Yes (heuristic) | No | No |
| Real-time instrumentation | Yes (trace/mark tools) | No | No (post-hoc) |
| Format support | Multi-format import/export | Own benchmark format | Perfetto/Chrome trace |
| Visualization | Export to speedscope/perfetto | Own dashboard | Built-in UI |
| Semantic frame conventions | Yes (kind:detail) | No | No |
| LLM-native output | Yes (structured for reasoning) | Yes (MCP) | No (SQL results) |

---

## 5. Tracemeld's Differentiators

- **MCP-native**: Purpose-built for LLM agent tool calls, not adapted from an existing profiling tool.
- **Semantic profiling**: Frame kind conventions (`bash:npm test`, `file_read:src/auth.ts`) enable kind-based analysis that generic profilers cannot do.
- **Anti-pattern detection**: Heuristic pattern matching for common LLM agent inefficiencies (redundant reads, excessive tool calls).
- **Baseline diffing with normalization**: Gregg-style differential analysis with automatic normalization for comparing sessions of different lengths.
- **Multi-format round-trip**: Import from pprof/Chrome/gecko/collapsed, analyze, export to speedscope/Chrome/baseline.

---

## 6. Competitive Gaps (What Tracemeld Lacks)

- **No SQL query interface**: Cannot do ad-hoc queries like Perfetto; limited to pre-built analysis tools.
- **No CI/CD integration**: No GitHub PR integration, no automated regression detection in CI pipelines.
- **No built-in visualization**: Relies on external tools (speedscope.app, ui.perfetto.dev) for visual flamegraphs and timelines.
- **No continuous profiling**: Snapshot-based, not streaming/continuous like production profiling systems.

---

## 7. Additional References

- Perfetto documentation: https://perfetto.dev/docs/
- Perfetto Python API: https://perfetto.dev/docs/analysis/batch-trace-processor
- PerfettoSQL getting started: https://perfetto.dev/docs/analysis/perfetto-sql-getting-started
- CodSpeed documentation: https://docs.codspeed.io/
- Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`
