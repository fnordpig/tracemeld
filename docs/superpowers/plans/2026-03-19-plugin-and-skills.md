# Tracemeld Plugin & Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package tracemeld as a Claude Code plugin with language-specific profiling skills, MCP prompts for guided analysis workflows, an MCP resource for profile context, and `.mcp.json` for zero-config installation — so that `claude plugin add tracemeld` gives users everything they need.

**Architecture:** The plugin bundles: (1) the MCP server via `.mcp.json`, (2) skills that teach Claude how to generate and import profile data for each language, (3) MCP prompts registered in `server.ts` for structured analysis workflows, and (4) an MCP resource exposing the active profile summary. Skills explicitly guide the LLM to use LSP (go-to-definition, hover) on source locations from analysis results, closing the loop from "what's slow" to "why it's slow in the code."

**Tech Stack:** Claude Code plugin format, MCP SDK (prompts + resources), SKILL.md files, shell scripts.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `.claude-plugin/plugin.json` | Plugin manifest — name, version, components |
| `.mcp.json` | MCP server definition for auto-registration |
| `skills/profile-rust/SKILL.md` | How to profile Rust code and import into tracemeld |
| `skills/profile-typescript/SKILL.md` | How to profile TypeScript/Node.js code |
| `skills/profile-python/SKILL.md` | How to profile Python code |
| `skills/profile-go/SKILL.md` | How to profile Go code |
| `skills/profile-cpp/SKILL.md` | How to profile C/C++ code |
| `skills/analyze-profile/SKILL.md` | Guided analysis workflow with LSP integration |
| `src/server.ts` | Modified — register MCP prompts + resource |

---

### Task 1: Plugin Manifest and MCP Config

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`

- [ ] **Step 1: Create plugin manifest**

```json
{
  "name": "tracemeld",
  "version": "0.1.0",
  "description": "LLM-native performance profiling — import traces, find bottlenecks, detect waste, and navigate to hot code via LSP",
  "author": "tracemeld",
  "license": "MIT",
  "keywords": ["profiling", "performance", "flamegraph", "pprof", "tracing"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

Save to `.claude-plugin/plugin.json`.

- [ ] **Step 2: Create MCP server config**

```json
{
  "mcpServers": {
    "tracemeld": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/build/cli.js"]
    }
  }
}
```

Save to `.mcp.json`.

- [ ] **Step 3: Commit**

```bash
mkdir -p .claude-plugin
git add .claude-plugin/plugin.json .mcp.json
git commit -m "feat: add plugin manifest and MCP server config"
```

---

### Task 2: Rust Profiling Skill

**Files:**
- Create: `skills/profile-rust/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: profile-rust
description: Profile Rust applications using samply, cargo-flamegraph, or perf, then import the trace into tracemeld for analysis. Use when the user wants to profile a Rust binary, find performance bottlenecks in Rust code, or analyze a Rust CPU profile.
---

# Profiling Rust Applications

## Profiling Methods (choose based on platform)

### Method 1: samply (macOS and Linux — recommended)

samply produces Gecko Profiler JSON, which tracemeld imports natively.

```bash
# Install samply
cargo install samply

# Build in release mode with debug symbols
cargo build --release

# Profile the binary
samply record ./target/release/YOUR_BINARY [args...]

# samply opens Firefox Profiler in a browser — close it
# The profile is saved to a temporary file. To save explicitly:
samply record -o profile.json ./target/release/YOUR_BINARY [args...]
```

Then import into tracemeld:
```
Use the import_profile tool with source="/path/to/profile.json" format="gecko"
```

### Method 2: cargo flamegraph (Linux — collapsed stacks)

cargo-flamegraph uses perf under the hood and produces collapsed stacks via inferno.

```bash
# Install
cargo install flamegraph

# Profile (generates flamegraph.svg AND perf.folded)
cargo flamegraph --bin YOUR_BINARY -- [args...]

# The collapsed stacks file is what we want:
# Look for perf.folded or use inferno directly:
perf record -g --call-graph dwarf ./target/release/YOUR_BINARY [args...]
perf script | inferno-collapse-perf > profile.folded
```

Then import:
```
Use the import_profile tool with source="/path/to/profile.folded" format="collapsed"
```

### Method 3: perf (Linux — collapsed stacks)

For systems without cargo-flamegraph:

```bash
# Build with debug info
RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release

# Record
perf record -F 99 -g --call-graph dwarf ./target/release/YOUR_BINARY [args...]

# Convert to collapsed stacks (requires inferno or stackcollapse-perf.pl)
perf script | inferno-collapse-perf > profile.folded
```

Then import:
```
Use the import_profile tool with source="/path/to/profile.folded" format="collapsed"
```

## After Import: Analysis with LSP

Once the profile is imported, follow this analysis pattern:

1. **Call `profile_summary`** to see headline numbers
2. **Call `hotspots`** or **`bottleneck`** with `dimension="wall_ms"` to find expensive functions
3. **For each hotspot with a `source` field**: Read the source file at the reported line using the Read tool or LSP hover to understand the function
4. **Call `explain_span`** on the hotspot's span_id for child breakdown
5. **Use LSP `findReferences`** on the hot function to understand all call sites
6. **Use LSP `incomingCalls`** to trace what invokes the bottleneck

The key insight: tracemeld tells you WHAT is slow (function name + source location), and LSP tells you WHY it's called and HOW it's implemented. Combine both for actionable optimization recommendations.

## Common Rust Performance Patterns to Look For

- **Unnecessary allocations**: Functions with high self-time that call `Vec::push`, `String::from`, `clone()`
- **Lock contention**: Use `starvations` tool if multiple threads are profiled
- **Serialization overhead**: Look for `serde` functions in hotspots
- **Iterator vs loop**: Sometimes iterators add overhead from bounds checking
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/profile-rust
git add skills/profile-rust/SKILL.md
git commit -m "feat: add Rust profiling skill"
```

---

### Task 3: TypeScript/Node.js Profiling Skill

**Files:**
- Create: `skills/profile-typescript/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: profile-typescript
description: Profile TypeScript and Node.js applications using V8's CPU profiler or Chrome DevTools, then import into tracemeld for analysis. Use when the user wants to profile a Node.js app, find JavaScript performance bottlenecks, or analyze a .cpuprofile or Chrome trace.
---

# Profiling TypeScript / Node.js Applications

## Profiling Methods

### Method 1: node --cpu-prof (simplest)

Node.js has a built-in CPU profiler that outputs Chrome-compatible .cpuprofile files.

```bash
# Profile a script
node --cpu-prof app.js

# Profile with custom output
node --cpu-prof --cpu-prof-dir=./profiles --cpu-prof-interval=1000 app.js

# Profile a TypeScript file (via tsx or ts-node)
npx tsx --cpu-prof app.ts
```

The output is a `.cpuprofile` file in Chrome DevTools format. Import it:
```
Use the import_profile tool with source="/path/to/CPU.*.cpuprofile" format="chrome_trace"
```

### Method 2: Chrome DevTools (for running servers)

For profiling a running Node.js server:

```bash
# Start with inspector
node --inspect app.js

# Or for TypeScript
npx tsx --inspect app.ts
```

1. Open `chrome://inspect` in Chrome
2. Click "inspect" on your Node.js process
3. Go to the Performance tab
4. Click Record, perform the operation you want to profile, click Stop
5. Click the down-arrow (Export) to save the trace as JSON

Import the exported trace:
```
Use the import_profile tool with source="/path/to/trace.json" format="chrome_trace"
```

### Method 3: 0x (flamegraph tool for Node.js)

```bash
# Install
npm install -g 0x

# Profile
0x app.js

# Generates a flamegraph HTML and a .0x directory with the raw data
# The collapsed stacks are in the .0x directory
```

## After Import: Analysis with LSP

1. **Call `bottleneck`** with `dimension="wall_ms"` — this shows the single functions where optimization helps most
2. **For each result with a `source` field**: The file and line point to your TypeScript/JavaScript source
3. **Use the Read tool** to read the function at that location
4. **Use LSP `hover`** to see the function's type signature — often reveals unnecessary type conversions or complex generics
5. **Use LSP `findReferences`** to see how often the hot function is called — maybe it's called in a tight loop unnecessarily
6. **Call `hotpaths`** to see the full call chains — "main → handleRequest → queryDatabase → serialize" tells you the narrative

## Common TypeScript/Node.js Performance Patterns

- **JSON.parse/stringify in hot paths**: Look for serialization functions in hotspots
- **Regex compilation**: `new RegExp()` inside loops
- **Synchronous I/O**: `readFileSync` in request handlers
- **Unnecessary awaits**: Sequential awaits where Promise.all would work
- **Large object spreading**: `{...obj, newProp}` on large objects creates copies
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/profile-typescript
git add skills/profile-typescript/SKILL.md
git commit -m "feat: add TypeScript/Node.js profiling skill"
```

---

### Task 4: Python Profiling Skill

**Files:**
- Create: `skills/profile-python/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: profile-python
description: Profile Python applications using py-spy, cProfile, or scalene, then import into tracemeld for analysis. Use when the user wants to profile Python code, find performance bottlenecks, or analyze a Python CPU profile.
---

# Profiling Python Applications

## Profiling Methods

### Method 1: py-spy (recommended — no code changes needed)

py-spy is a sampling profiler that can attach to running Python processes without modification.

```bash
# Install
pip install py-spy

# Profile a script — output as speedscope JSON
py-spy record -o profile.json --format speedscope -- python your_script.py

# Profile a running process
py-spy record -o profile.json --format speedscope -p PID

# Output as collapsed stacks (simpler, always works)
py-spy record -o profile.folded --format raw -- python your_script.py
```

Import the collapsed stacks format (most reliable):
```
Use the import_profile tool with source="/path/to/profile.folded" format="collapsed"
```

### Method 2: cProfile (built-in, no install)

```bash
# Profile a script
python -m cProfile -o profile.prof your_script.py

# Convert to collapsed stacks using flameprof or gprof2dot
pip install flameprof
python -m flameprof profile.prof > profile.folded
```

### Method 3: scalene (CPU + memory + GPU)

```bash
pip install scalene
scalene --json --outfile profile.json your_script.py
```

## After Import: Analysis with LSP

1. **Call `hotspots`** with `dimension="wall_ms"` to find expensive functions
2. **For each hotspot with a `source` field** (e.g., `source: { file: "app/models.py", line: 42 }`):
   - Read the file at that line to see the function
   - Use LSP `hover` to check type annotations — missing types can indicate dynamic dispatch overhead
   - Use LSP `findReferences` to see all call sites
3. **Call `spinpaths`** — Python is single-threaded (GIL), so high wall time with low output often means I/O blocking or GIL contention
4. **Call `find_waste`** to identify redundant operations

## Common Python Performance Patterns

- **List comprehension vs generator**: `[x for x in range(1M)]` allocates everything; use `(x for x in range(1M))`
- **String concatenation in loops**: Use `''.join()` instead of `+=`
- **Global variable lookup**: Local variables are faster than globals in Python
- **pandas anti-patterns**: `iterrows()` vs vectorized operations
- **Import overhead**: Heavy imports at module level slow startup
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/profile-python
git add skills/profile-python/SKILL.md
git commit -m "feat: add Python profiling skill"
```

---

### Task 5: Go Profiling Skill

**Files:**
- Create: `skills/profile-go/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: profile-go
description: Profile Go applications using go tool pprof, runtime/pprof, or net/http/pprof, then import into tracemeld for analysis. Use when the user wants to profile Go code, find performance bottlenecks, or analyze a pprof CPU profile.
---

# Profiling Go Applications

## Profiling Methods

### Method 1: go test -cpuprofile (for benchmarks)

The simplest way to profile Go code:

```bash
# Profile benchmarks
go test -cpuprofile cpu.prof -bench .

# Profile a specific benchmark
go test -cpuprofile cpu.prof -bench BenchmarkMyFunc -benchtime 10s
```

Import the pprof file:
```
Use the import_profile tool with source="/path/to/cpu.prof" format="pprof"
```

### Method 2: runtime/pprof (for applications)

Add profiling to your main function:

```go
import (
    "os"
    "runtime/pprof"
)

func main() {
    f, _ := os.Create("cpu.prof")
    pprof.StartCPUProfile(f)
    defer pprof.StopCPUProfile()

    // ... your application code ...
}
```

Then run normally and import `cpu.prof`.

### Method 3: net/http/pprof (for servers)

For running HTTP servers, import the pprof handler:

```go
import _ "net/http/pprof"
```

Then capture a profile while the server is under load:

```bash
# 30-second CPU profile
go tool pprof -proto -output=cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
```

## After Import: Analysis with LSP

Go profiles have excellent source information (function names include full package paths, file paths, and line numbers).

1. **Call `bottleneck`** with `dimension="cpu"` (or whatever the profile's value type is — check `profile_summary` first)
2. **The `source` field** will show paths like `source: { file: "pkg/server/handler.go", line: 142 }` — these map directly to your source files
3. **Read the function** at that location
4. **Use LSP `goToDefinition`** on types and function calls within the hot function to understand the call chain
5. **Use LSP `findReferences`** on the hot function to see all callers — maybe it's called unnecessarily in some paths
6. **Call `hotpaths`** to see the full call chain from main → handler → hot function

## Common Go Performance Patterns

- **Excessive allocation**: Look for functions creating many small objects — use `sync.Pool` or pre-allocate
- **Lock contention**: Use `starvations` tool; look for `sync.Mutex` in hot paths
- **String building**: `fmt.Sprintf` in hot loops — use `strings.Builder`
- **Interface dispatch**: Calling methods through interfaces adds indirection
- **Channel overhead**: Unbuffered channels in tight loops cause goroutine scheduling overhead
- **Defer overhead**: `defer` in very hot, tight loops adds measurable cost
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/profile-go
git add skills/profile-go/SKILL.md
git commit -m "feat: add Go profiling skill"
```

---

### Task 6: C/C++ Profiling Skill

**Files:**
- Create: `skills/profile-cpp/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: profile-cpp
description: Profile C and C++ applications using perf, samply, or Instruments, then import into tracemeld for analysis. Use when the user wants to profile C/C++ code, find performance bottlenecks, or analyze a perf or Gecko profile.
---

# Profiling C/C++ Applications

## Prerequisites

**Always compile with debug info and frame pointers:**

```bash
# GCC/Clang
gcc -O2 -g -fno-omit-frame-pointer -o myapp myapp.c
g++ -O2 -g -fno-omit-frame-pointer -o myapp myapp.cpp

# CMake
cmake -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_C_FLAGS="-fno-omit-frame-pointer" ..
```

Without `-fno-omit-frame-pointer`, stack traces will be incomplete.

## Profiling Methods

### Method 1: samply (macOS and Linux — recommended)

```bash
# Install (requires Rust toolchain)
cargo install samply

# Profile
samply record ./myapp [args...]

# Save to file
samply record -o profile.json ./myapp [args...]
```

Import the Gecko JSON:
```
Use the import_profile tool with source="/path/to/profile.json" format="gecko"
```

### Method 2: perf + inferno (Linux)

```bash
# Record with call graph
perf record -F 99 -g --call-graph dwarf ./myapp [args...]

# Convert to collapsed stacks
perf script | inferno-collapse-perf > profile.folded

# If you don't have inferno, use Brendan Gregg's scripts:
perf script | stackcollapse-perf.pl > profile.folded
```

Import:
```
Use the import_profile tool with source="/path/to/profile.folded" format="collapsed"
```

### Method 3: Instruments (macOS only)

1. Open Instruments.app → Time Profiler template
2. Record your application
3. File → Export Trace (or use the deep copy export)

## After Import: Analysis with LSP

C/C++ profiles typically have very detailed source locations because debug info maps directly to source lines.

1. **Call `bottleneck`** with `dimension="wall_ms"`
2. **For each hotspot with `source`**: The file and line will be your C/C++ source — read it
3. **Use LSP `hover`** on the hot function to see its full signature
4. **Use LSP `incomingCalls`** to find all callers of the hot function
5. **Use LSP `outgoingCalls`** to see what the hot function calls — maybe an inner call dominates
6. **Call `starvations`** if profiling a multi-threaded program — lock contention is the #1 C/C++ perf issue

## Common C/C++ Performance Patterns

- **Cache misses**: Functions touching large, non-contiguous data structures (linked lists vs vectors)
- **Virtual function dispatch**: vtable lookups in hot loops — consider CRTP or compile-time polymorphism
- **Unnecessary copies**: Look for copy constructors in hot paths — use move semantics or references
- **Lock contention**: `starvations` tool reveals thread idle time. Consider lock-free data structures
- **Branch misprediction**: Unpredictable branches in hot loops — consider branchless alternatives
- **Allocation pressure**: `malloc`/`new` in hot paths — use memory pools or arena allocators
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/profile-cpp
git add skills/profile-cpp/SKILL.md
git commit -m "feat: add C/C++ profiling skill"
```

---

### Task 7: Analysis Workflow Skill (with LSP integration)

**Files:**
- Create: `skills/analyze-profile/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: analyze-profile
description: Guided performance analysis workflow using tracemeld MCP tools and LSP. Use after importing a profile to systematically find, understand, and fix performance bottlenecks. This skill teaches the full analysis loop from profile data to code changes.
---

# Performance Analysis Workflow

This skill guides you through analyzing a performance profile using tracemeld's MCP tools, then using LSP to understand and fix the bottlenecks found.

## Step 1: Get the Overview

```
Call profile_summary with group_by="kind"
```

Read the result. Look for:
- Which group has the highest `pct_of_total` on `wall_ms` or the primary cost dimension
- Any groups flagged with `investigate` — these are where >40% of cost is concentrated
- The `error_count` — errors often indicate wasted work

## Step 2: Find What's Slow

```
Call bottleneck with dimension="wall_ms" top_n=5
```

This ranks operations by optimization impact. Each result includes:
- `name` — the function/operation name
- `source` — **if present, this is a file:line reference you should read**
- `impact_score` — higher means fixing this moves the needle more
- `recommendation` — a concrete suggestion

**For each of the top 3 results that have a `source` field:**

1. **Read the source code** at the reported file and line
2. **Use LSP `hover`** on the function name to see its type signature and documentation
3. **Use LSP `findReferences`** to see how many places call this function
4. **Use LSP `incomingCalls`** to understand the call hierarchy leading to this bottleneck

## Step 3: Understand the Call Paths

```
Call hotpaths with dimension="wall_ms" top_n=5
```

This shows complete root-to-leaf paths. Unlike bottleneck (which shows individual functions), hotpaths shows the full narrative: "main → handleRequest → queryDB → marshalJSON".

For each path, the `leaf_source` field tells you where the actual time is spent.

## Step 4: Look for Waste

```
Call find_waste
```

This detects anti-patterns:
- **retry_loop** — same operation retried after failure (wasted time)
- **redundant_read** — same file read twice without editing (wasted tokens)
- **blind_edit** — file edited without reading first (risky)

Each waste item includes `counterfactual_savings` — how much would be saved if eliminated.

## Step 5: Deep Dive on Specific Spans

For any hotspot or waste item, get the full story:

```
Call explain_span with span_id="<from previous results>"
```

This shows:
- The span's children sorted by cost
- A causal chain of what happened chronologically
- Source locations for each child — **read these to understand the execution flow**

## Step 6: Check for Thread Issues

If the profile has multiple lanes/threads:

```
Call starvations
```

This reveals threads that were idle while others were busy — indicating lock contention, unbalanced work, or serialization bottlenecks.

```
Call spinpaths
```

This reveals operations that spent time without producing output — busy-waiting or spinning.

## The LSP Integration Pattern

The power of tracemeld + LSP:

1. **tracemeld tells you WHAT is slow** — function names, costs, call paths, source locations
2. **LSP tells you WHY and HOW** — type signatures, call hierarchies, all references

Example workflow:
```
bottleneck says: "queryDatabase at src/db/queries.ts:42 accounts for 65% of wall time"
→ Read src/db/queries.ts:42 to see the function
→ LSP hover shows: function queryDatabase(query: string): Promise<Result[]>
→ LSP findReferences shows: called 47 times from 3 files
→ LSP incomingCalls shows: handleRequest → processItems (loop!) → queryDatabase
→ Insight: queryDatabase is called inside a loop — batch the queries instead
```

## When to Use Which Tool

| Question | Tool |
|----------|------|
| "How did the session go?" | `profile_summary` |
| "What's the single biggest optimization?" | `bottleneck` |
| "What functions are expensive?" | `hotspots` |
| "What call chains dominate?" | `hotpaths` |
| "Why is this specific span slow?" | `explain_span` |
| "What work was wasted?" | `find_waste` |
| "Is anything spinning/blocked?" | `spinpaths` |
| "Are threads underutilized?" | `starvations` |
```

- [ ] **Step 2: Commit**

```bash
mkdir -p skills/analyze-profile
git add skills/analyze-profile/SKILL.md
git commit -m "feat: add analysis workflow skill with LSP integration guidance"
```

---

### Task 8: Register MCP Prompts and Profile Resource in server.ts

**Files:**
- Modify: `src/server.ts`

This registers two MCP prompts (`performance_review` and `optimize_for`) and one MCP resource (`profile://summary`) that exposes the current profile state.

- [ ] **Step 1: Read current server.ts**

- [ ] **Step 2: Add prompt and resource registrations**

After the last `server.registerTool(...)` call and before `return server;`, add:

```typescript
// --- MCP Prompts ---

server.registerPrompt(
  'performance_review',
  {
    title: 'Performance Review',
    description: 'Step-by-step analysis of the current profile. Finds hotspots, traces call paths, identifies waste, and produces actionable recommendations with source locations.',
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
    argsSchema: z.object({
      dimension: z.string().describe('The cost dimension to optimize: wall_ms, input_tokens, output_tokens, cost_usd, etc.'),
    }),
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

// --- MCP Resource ---

server.registerResource(
  'profile-summary',
  'profile://summary',
  {
    title: 'Current Profile Summary',
    description: 'Headline numbers from the active tracemeld profile — span count, error count, cost totals by kind. Read this for context before analysis.',
    mimeType: 'application/json',
  },
  async () => {
    const { profileSummary } = await import('./analysis/summary.js');
    const summary = profileSummary(state.builder.profile, { group_by: 'kind' });
    return {
      contents: [{
        uri: 'profile://summary',
        text: JSON.stringify(summary, null, 2),
      }],
    };
  },
);
```

- [ ] **Step 3: Add import for GetPromptResult type if needed**

The MCP SDK's `registerPrompt` callback should return `{ messages: [...] }` directly. Check that the return type works without an explicit import. If TypeScript complains, add:

```typescript
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Build and smoke test**

```bash
npx tsc
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | node build/cli.js
```

Verify the response includes `capabilities.prompts` and `capabilities.resources`.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run && npx eslint src/`
Expected: All tests pass, no lint errors. (Existing tests should not break since we only added, not changed.)

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "feat: register MCP prompts (performance_review, optimize_for) and profile summary resource"
```

---

### Task 9: Update CLAUDE.md and index.ts

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/index.ts`

- [ ] **Step 1: Update CLAUDE.md with plugin information**

Add a section about the plugin structure and available skills:

```markdown
### Plugin Structure
- `skills/profile-rust/` — How to profile Rust (samply, cargo-flamegraph, perf)
- `skills/profile-typescript/` — How to profile TypeScript/Node.js (--cpu-prof, Chrome DevTools)
- `skills/profile-python/` — How to profile Python (py-spy, cProfile)
- `skills/profile-go/` — How to profile Go (go test -cpuprofile, runtime/pprof)
- `skills/profile-cpp/` — How to profile C/C++ (perf, samply, Instruments)
- `skills/analyze-profile/` — Guided analysis workflow with LSP integration

### MCP Prompts
- `performance_review` — Full step-by-step analysis with LSP-guided source reading
- `optimize_for` — Targeted optimization for a specific cost dimension

### MCP Resource
- `profile://summary` — Current profile headline numbers (read for context)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md src/index.ts
git commit -m "docs: update CLAUDE.md with plugin structure and MCP prompts"
```

---

## Summary

After completing all 9 tasks, tracemeld will be a complete Claude Code plugin with:

- **Plugin manifest** — `.claude-plugin/plugin.json` for `claude plugin add`
- **MCP config** — `.mcp.json` for auto-registration of the tracemeld server
- **5 language profiling skills** — Rust, TypeScript, Python, Go, C/C++ with exact commands, output format mapping, and LSP integration guidance
- **1 analysis workflow skill** — Guided analysis loop: profile_summary → bottleneck → LSP read source → hotpaths → find_waste → recommendations
- **2 MCP prompts** — `performance_review` (full analysis) and `optimize_for` (targeted)
- **1 MCP resource** — `profile://summary` for profile context

The LSP integration is woven throughout: every skill teaches the pattern of "tracemeld tells you WHAT, LSP tells you WHY" — hotspot → source location → Read file → LSP hover/findReferences/incomingCalls → understand the code → make informed optimization recommendation.
