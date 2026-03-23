# Competitive Landscape: MCP-Based and Trace-Analysis Profiling Tools

Reference distillation for tracemeld roadmap planning. Covers the two most relevant competitive/adjacent tools: CodSpeed (MCP-native CI benchmarking) and Perfetto (SQL-over-traces analysis engine).

---

## 1. CodSpeed MCP Server

**Announced**: March 16, 2026
**Source**: https://codspeed.io/changelog/2026-03-16-mcp-server

CodSpeed launched "CodSpeed for Agents" on March 16, 2026, bringing CI/CD performance benchmarking data into LLM agent workflows via an MCP server and agent skills.

### Focus

CI/CD performance benchmarking with deep GitHub integration. CodSpeed instruments benchmark suites in CI pipelines, measures performance with CPU simulation (less than 1% variance, hardware-independent), and surfaces regressions on pull requests. The MCP server brings this data into agent-assisted development workflows. Shows performance impact of PRs directly within the agent conversation.

### MCP Tools (5 tools)

1. **Query flamegraphs** — Surface functions with the highest self time, walk the call tree, cross-reference hot spots with source code to suggest targeted fixes.
2. **Compare runs** — Generate a full performance report between any two runs with benchmark-level diffs showing regressions, improvements, and new or missing benchmarks.
3. **Get run details** — Inspect a single run and its benchmark results.
4. **List runs** — Browse recent performance runs with commit, branch, and PR metadata.
5. **List repositories** — See all CodSpeed-enabled repositories.

These tools enable querying benchmark history, comparing runs across commits, and detecting regressions — all from within the agent's MCP tool interface.

### Agent Skills

CodSpeed ships two agent "skills" (structured prompts that teach the assistant multi-step workflows):

- **codspeed-optimize** — Turns the agent into an autonomous performance engineer. Point it at a slow function or a regression and it loops: measure, analyze the flamegraph, make a targeted change, re-measure, compare, until there is nothing left to gain.
- **codspeed-setup-harness** — Detects project structure, picks the right benchmark framework for the language, writes benchmarks, and verifies everything works. Supports Rust, Python, Node.js, Go, C/C++.

### Architecture and Integration

- **Cloud-dependent**: CodSpeed is a SaaS platform. The MCP server is a thin client that queries CodSpeed's API for pre-collected benchmark data. Traces are collected during CI runs using CodSpeed's runner/instrumenter.
- **Installation**: Available as a Claude Code plugin or via `npx add-mcp` for other MCP clients.
- **Flamegraph features**: Automatically detects inlined frames. "By Origin" coloring mode separates User, Library, and System spans.
- **CodSpeed CLI** (January 2026): Benchmark any executable with a single command — no code changes, no framework required. Simulation Mode provides CPU simulation for hardware-independent measurements.
- **Hardware counters** (January 2026): Collects CPU cycles, instruction counts, memory operations, and cache behavior via `perf` during walltime profiling.

### Key Difference from Tracemeld

CodSpeed focuses on **CI-time benchmarking of code changes**: the workflow is write code, push PR, CI runs benchmarks, CodSpeed detects regressions, agent queries CodSpeed MCP to understand and fix them. Tracemeld focuses on **real-time LLM agent session profiling during development**: the workflow is the agent instruments its own operations (tool calls, file reads, shell commands) as they happen, building a profile of the current session for immediate analysis.

CodSpeed answers "did this PR make the code slower?" Tracemeld answers "why is this agent session slow right now?"

---

## 2. Perfetto Trace Processor

**Source**: https://perfetto.dev/docs/analysis/trace-processor

The Trace Processor is Perfetto's C++ library for ingesting traces in multiple formats and exposing them through a SQL query interface. It is the analytical backbone of the Perfetto ecosystem — a SQL-over-traces engine.

### Architecture

Loads Chrome, Android, Linux ftrace, and Perfetto-native traces into an in-memory SQLite-derived database. All trace data is normalized into a consistent relational schema regardless of input format. The query engine is PerfettoSQL, a dialect of SQL that extends SQLite with trace-optimized constructs.

### Core SQL Tables

The key capability is that traces are exposed as SQL tables, enabling arbitrary queries:

| Table | Contents |
|---|---|
| `slice` | Userspace spans (begin/end events) — has `ts`, `dur`, `name`, `track_id`, `parent_id`. Equivalent to tracemeld's `Span` |
| `sched_slice` | Kernel scheduling slices from ftrace sched/switch events |
| `thread_state` | Per-thread scheduling state over time |
| `thread_track` | Timeline tracks scoped to threads |
| `process_track` | Timeline tracks scoped to processes |
| `counter` | Continuous time-varying values (CPU freq, memory, custom counters) |
| `thread` | Thread metadata (name, tid, `utid`) |
| `process` | Process metadata (name, pid, `upid`) |
| `args` | Key-value arguments attached to slices and other events (accessed via `EXTRACT_ARG()`) |
| `instant` | Point-in-time events (equivalent to tracemeld markers) |
| `cpu_track` / `gpu_track` | CPU- and GPU-scoped tracks |
| `metadata` | Trace and system metadata |

Perfetto uses `utid` (unique tid) and `upid` (unique pid) as stable identifiers since OS-level pid/tid can be reused within a trace.

### Key Capability: Arbitrary SQL Queries

The defining strength of Perfetto's analytical model is that any question about trace data can be expressed as a SQL query:

```sql
-- Find the 10 longest slices
SELECT name, dur, ts FROM slice ORDER BY dur DESC LIMIT 10;

-- CPU utilization per process
SELECT p.name, SUM(s.dur) as total_cpu
FROM sched_slice s JOIN thread t USING(utid) JOIN process p USING(upid)
GROUP BY p.name ORDER BY total_cpu DESC;
```

### CLI Usage

```bash
trace_processor trace.perfetto-trace --query "SELECT name, dur FROM slice ORDER BY dur DESC LIMIT 10"
```

### PerfettoSQL Extensions Beyond SQLite

- **`CREATE PERFETTO TABLE`** — Tables optimized for analytic queries on traces, more performant and memory-efficient than SQLite native tables.
- **`CREATE PERFETTO INDEX`** — Indexes with sorted column storage for fast range lookups.
- **`CREATE PERFETTO MACRO`** — SQL macros inspired by Rust macro design.
- **`SPAN_JOIN` operator** — Custom operator table that computes the intersection of time spans from two tables/views. Powerful for correlating events across tracks.
- **`ANCESTOR_SLICE(id)` / `DESCENDANT_SLICE(id)`** — Recursive slice tree traversal operators.

### Trace-Based Metrics

Pre-baked metric computations curated by domain experts that output structured JSON/Protobuf/text summaries. These provide high-level answers (e.g., "what was the startup time?") without writing SQL. Conceptually similar to tracemeld's opinionated analysis tools (profile_summary, hotspots, etc.) but driven by SQL under the hood.

### WASM-Based UI

Interactive web UI at https://ui.perfetto.dev for trace exploration. Supports timeline views, flamegraphs, SQL query console, and metric dashboards. All processing happens client-side via WASM.

---

## 3. PerfettoSQL Standard Library

**Source**: https://perfetto.dev/docs/analysis/stdlib-docs

A repository of reusable tables, views, functions, and macros organized by domain. Design inspired by standard libraries in Python, C++, and Java — raising the abstraction level above raw SQL tables. Pre-built functions and macros that encode domain-expert knowledge about specific trace analysis patterns.

### Module Organization

Modules are imported with `INCLUDE PERFETTO MODULE <name>`:

| Module | Domain | Example Contents |
|---|---|---|
| `android` | Android platform | DVFS counter stats, jank classification (SF vs app), Low Memory Killer analysis |
| `chrome` | Chromium browser | Scroll slice definitions (`chrome_scrolls`), scroll update critical path timing, janky event latency detection (`chrome_janky_event_latencies_v3`), scroll jank intervals |
| `linux` | Linux kernel | CPU utilization per slice (`linux.cpu.utilization.slice`), scheduling analysis, ftrace event visualization |
| `slices` | Slice analysis | `slices.with_context` for enriching raw slices with thread/process context |
| `counters` | Counter data | `counters.intervals` for duration computation, counter value aggregation |
| `cpu` | CPU analysis | CPU scheduling and utilization breakdowns |
| `memory` | Memory analysis | Memory allocation and usage tracking |
| `scheduling` | Thread scheduling | Thread state analysis, runnable/sleeping breakdowns |
| `intervals` | Time intervals | Time interval intersection and union operations |

### Usage Pattern

```sql
INCLUDE PERFETTO MODULE linux.cpu.utilization.slice;
-- Now use tables/functions defined in that module
SELECT * FROM linux_cpu_utilization_per_slice;
```

### Example Analysis Capabilities

- **Thread slices**: `slices.with_context` enriches the `slice` table with thread name, process name, and track info — turning raw slice IDs into human-readable analysis.
- **Process counters**: `counters.intervals` computes duration-weighted counter values per process, enabling "average CPU frequency during this function" queries.
- **Scheduling analysis**: Linux scheduling modules correlate `sched_slice` with `thread_state` to compute runqueue latency, CPU utilization per thread, and scheduling jitter.

### Value of Domain-Specific Abstractions

The stdlib demonstrates that domain-specific analysis abstractions on top of raw trace data are essential for practical use. Raw SQL tables are powerful but verbose; stdlib modules encode expert knowledge into reusable queries. This validates tracemeld's approach of shipping curated analysis tools rather than exposing raw data, and suggests that as tracemeld's tool set grows, organizing analysis by domain (LLM agent patterns, CLI tool patterns, file I/O patterns) would follow a proven model.

---

## 4. Competitive Positioning Matrix

| Capability | Tracemeld | CodSpeed | Perfetto |
|---|---|---|---|
| Interface | MCP tools | MCP tools | SQL + GUI |
| Primary use | LLM agent profiling | CI benchmarking | System trace analysis |
| Query model | Opinionated analysis tools | Benchmark comparison | Arbitrary SQL |
| Baseline/diff | Yes (planned) | Yes (CI-native) | Manual SQL |
| Anti-pattern detection | Yes | No | No |
| Real-time instrumentation | Yes (trace/mark) | No | No |
| Format support | Multi-format import/export | Own format | Perfetto/Chrome trace |
| Visualization | Export to speedscope/perfetto | Own dashboard | Built-in UI |
| Agent integration | Native (is an MCP server) | MCP server + skills | None |
| Deployment | Local, stateless, zero dependencies | Cloud SaaS | Local C++ binary or WASM |
| Language support | Language-agnostic (profiles agent ops) | Rust, Python, Node.js, Go, C/C++ | Language-agnostic (system-level) |
| Measurement model | Wall-clock spans + markers | CPU simulation (deterministic) | Hardware counters + ftrace + userspace |
| Multi-dimensional values | Yes (wall_ms, tokens, cost) | Single dimension | Single dimension per counter/slice |

---

## 5. Competitive Gaps

### Tracemeld Advantages

- **MCP-native**: Purpose-built for LLM agent workflows. The profiler is the agent's own tool, not an external service the agent queries.
- **Semantic profiling**: Frame kind conventions (`bash:`, `file_read:`, `llm_call:`, `user_input:`) encode what the agent was doing, not just where CPU time went.
- **Baseline diffing with normalization**: Planned differential analysis that accounts for session variability (idle time exclusion, normalization across different session lengths).
- **Anti-pattern detection heuristics**: Codified patterns like redundant file reads, excessive subprocess spawning, context window waste — domain knowledge that SQL queries cannot easily express.
- **Multi-format import/export**: Can ingest pprof, Chrome trace, collapsed stacks, Gecko profiles and export to speedscope/Chrome trace formats, acting as a format bridge.
- **Stateless design**: No database, no daemon, no infrastructure. Profile lives in MCP server memory for the duration of the session.

### Gaps vs Competitors

- **No SQL query interface** (vs Perfetto): Users cannot ask arbitrary questions about trace data. Every analysis capability must be anticipated and implemented as a tool. Perfetto's SQL model is infinitely flexible; tracemeld's tool model is opinionated but limited.
- **No CI/CD integration** (vs CodSpeed): No concept of benchmark runs, PR comparisons, or regression detection across commits. CodSpeed owns the CI performance feedback loop; tracemeld operates only within a single development session.
- **No built-in visualization**: Relies on speedscope and Perfetto UI for visual inspection. CodSpeed has its own dashboard; Perfetto has a full WASM-based UI. Tracemeld produces data files that must be opened elsewhere.
- **No continuous profiling infrastructure**: No persistent storage, no historical trend analysis, no fleet-wide aggregation. Each session is ephemeral.
- **No deterministic measurement**: CodSpeed's CPU simulation provides sub-1% variance measurements. Tracemeld measures wall-clock time, which is inherently noisy (affected by system load, network latency, LLM provider response times).

### Strategic Position

Tracemeld occupies a unique niche: it is the only tool that provides **live, in-session performance profiling for LLM agent workflows via MCP**. Neither CodSpeed (which profiles CI benchmark suites) nor Perfetto (which analyzes post-hoc system traces) addresses this use case. The primary risk is that CodSpeed extends its MCP server to support live instrumentation, which would create direct competition. Tracemeld's defense is depth of analysis (anti-patterns, multi-dimensional diffs, semantic framing) and independence from any SaaS platform.

---

## 6. Additional References

### Perfetto
- Perfetto Python API (batch trace processing): https://perfetto.dev/docs/analysis/batch-trace-processor
- Trace Processor CLI docs: https://perfetto.dev/docs/analysis/trace-processor
- PerfettoSQL getting started: https://perfetto.dev/docs/analysis/perfetto-sql-getting-started
- PerfettoSQL syntax reference: https://perfetto.dev/docs/analysis/perfetto-sql-syntax
- PerfettoSQL built-in tables: https://perfetto.dev/docs/analysis/sql-tables
- Perfetto trace-based metrics: https://perfetto.dev/docs/analysis/metrics

### CodSpeed
- CodSpeed MCP server announcement: https://codspeed.io/changelog/2026-03-16-mcp-server
- CodSpeed CLI announcement: https://codspeed.io/changelog/2026-01-23-introducing-codspeed-cli
- CodSpeed documentation: https://docs.codspeed.io/

### Parent document
- Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`
