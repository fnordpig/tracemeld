# Baseline workflow: measuring what changed

This document teaches you how to use tracemeld's baseline system to answer the question that matters most in optimization work: *did it actually help?*

The baseline workflow turns tracemeld from a profiler into a measurement instrument. You snapshot a profile before a change, snapshot it after, and the diff tells you — across every cost dimension simultaneously — what improved, what regressed, and what shifted without actually changing.

---

## The three tools

### `save_baseline`

Snapshots the current in-memory profile as a compact JSON digest. The digest contains everything needed for future comparison: headline totals, per-kind breakdown, frame-level cost aggregation, top hotspots, detected anti-patterns, and summary statistics. It does *not* contain the full span tree — it's a lossy projection optimized for diffing, typically 5–30KB even for profiles with hundreds of spans.

```
save_baseline({
  name: "auth-refactor-before",
  checkpoint: "before",
  task: "Reduce token cost of authentication flow",
  commit: "a1b2c3d"
})
```

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | yes | Filename-safe identifier. Becomes `{name}.baseline.json`. |
| `checkpoint` | yes | Semantic tag: `"before"`, `"after"`, `"baseline"`, `"release"`, or `"custom"`. |
| `task` | no | Human-readable description of what's being measured. Carried into the diff output. |
| `commit` | no | Git commit hash. Useful for CI integration and later forensics. |
| `tags` | no | Arbitrary key-value metadata. Stored in the digest. |
| `output_dir` | no | Default: `.tracemeld/baselines/`. Override for non-standard project layouts. |

**What it writes:** `{output_dir}/{name}.baseline.json` — a `BaselineDigest` containing:

- `totals` — headline cost across all value dimensions (wall_ms, input_tokens, etc.)
- `kind_breakdown` — per-kind aggregation (bash, file_read, thinking, etc.) with span counts and error counts
- `frame_costs` — every unique call stack path with self-cost, total-cost, and call count per dimension. This is the data structure the diff algorithm operates on. It uses the same semicolon-delimited ancestry format as collapsed stacks: `thinking:planning;bash:npm test;file_read:src/auth.ts`
- `hotspots` — top 10 by each dimension
- `patterns` — anti-patterns detected at capture time (retry storms, blind edits, redundant reads)
- `stats` — span_count, sample_count, frame_count, lane_count, error_count, wall_duration_ms

**Returns:** The file path, digest size in bytes, and headline totals so you get immediate confirmation.

---

### `list_baselines`

Scans the baselines directory and returns a summary of each stored digest, sorted most-recent-first.

```
list_baselines()
```

Returns for each baseline: filename, checkpoint type, task description, commit hash, creation timestamp, headline totals, and stats. Use this to find the right baseline to diff against — especially useful when a project accumulates baselines over multiple optimization sessions.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `baselines_dir` | no | Default: `.tracemeld/baselines/`. |

---

### `diff_profile`

Compares the current in-memory profile against a stored baseline. This is the payoff tool — it answers "did it get faster?" and "what got slower?" across every cost dimension at once.

```
diff_profile({
  baseline: "auth-refactor-before"
})
```

You can pass either a baseline name (resolved to `.tracemeld/baselines/{name}.baseline.json`) or a full file path.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `baseline` | yes | Baseline name or path to `.baseline.json` file. |
| `dimension` | no | Primary dimension to rank by. Default: first value type (usually `wall_ms`). |
| `min_delta_pct` | no | Minimum percentage change to report. Default: 5%. Raise to focus on large changes only. |
| `normalize` | no | Scale the before profile's counts so totals match. Default: true. **Almost always leave this on** — see the normalization section below. |

**What it returns:**

The `DiffResult` structure contains:

**`headline`** — Per-dimension total comparison. For each dimension: before value, after value, absolute delta, and percentage delta. This is the first thing to look at.

**`regressions`** — Call stacks where cost *increased*, ranked by absolute delta on the primary dimension. Each entry includes the stack path, leaf frame name, before/after/delta costs across all dimensions, and percentage change. Entries flagged `likely_refactoring: true` are cost shifts (see below), not real regressions.

**`improvements`** — Call stacks where cost *decreased*. Same structure as regressions.

**`new_stacks`** — Call stacks that exist in the current profile but didn't exist in the baseline. These are entirely new work — new functions called, new tool invocations, new code paths.

**`removed_stacks`** — Call stacks that existed in the baseline but are gone now. Work that was eliminated.

**`regression_warnings`** — Any dimension where the *total* cost increased. Even if most functions got faster, if one dimension's total went up, it's flagged here.

**`pattern_diff`** — Anti-patterns that are new (appeared after the change) or resolved (were present before, gone now).

---

## Normalization: why it matters

When you profile a session before a change and again after, the two sessions almost never have the same total duration or workload. The "before" run might take 30 seconds; the "after" might take 60 because you ran more tests. Without normalization, every single stack would show as a regression — the session was simply longer.

Normalization scales the before profile's costs by `total_after / total_before` for each dimension, making the totals equal. After normalization:

- A delta of 0 means "same proportion of total work" — the function's share of the overall cost didn't change.
- A positive delta means the function takes a larger share of work than before — a real regression.
- A negative delta means the function takes a smaller share — a real improvement.

This follows the algorithm from Brendan Gregg's `difffolded.pl`, the canonical implementation of differential flamegraphs. Normalization is on by default. Turn it off only when comparing profiles of identical workloads (same inputs, same duration, same load).

The percentage formula uses the flamegraph.pl convention: `(after - before) / after * 100`. This means the percentage represents "what fraction of the current width is attributable to the change." A function going from 6 to 7 units shows +14.3% (1/7), not +16.7% (1/6).

---

## Cost shift detection

Not every regression is real. When you refactor code — moving logic from function A to function B — function B's cost goes up and A's goes down, but the parent function's total cost is unchanged. No actual regression occurred; work just moved.

The diff engine detects this automatically, inspired by Meta's FBDetect research on subroutine-level regression detection. For each regression, it checks whether the parent stack's total cost also changed. If the parent's total cost is stable (within ±2%), the child's regression is flagged as `likely_refactoring: true`.

When you see `likely_refactoring` in a diff result, don't treat it as something to fix. It means cost moved between children of a stable parent — the code was reorganized, not made slower.

---

## Scenario 1: Before/after optimization

The most common workflow. You have a profile loaded and want to measure the impact of a code change.

**Step 1: Baseline the current state.**

```
save_baseline({
  name: "slow-auth-before",
  checkpoint: "before",
  task: "Optimize authentication token validation"
})
```

**Step 2: Analyze to find targets.** Call `profile_summary`, `bottleneck`, and `find_waste` to understand where to focus.

**Step 3: Make the change.** Edit the code. In this example, suppose you cache token validation results to avoid redundant crypto operations.

**Step 4: Re-profile.** Run the workload again. If using live instrumentation, the new trace data builds in tracemeld as you work. If using imported profiles, call `import_profile` with the new trace file.

**Step 5: Baseline the new state.**

```
save_baseline({
  name: "slow-auth-after",
  checkpoint: "after",
  task: "Optimize authentication token validation"
})
```

**Step 6: Diff.**

```
diff_profile({
  baseline: "slow-auth-before"
})
```

**Step 7: Interpret.** The headline tells you the net impact across all dimensions. The regressions and improvements tell you which specific call stacks changed. The pattern_diff tells you whether you introduced new anti-patterns or resolved existing ones.

A good result looks like:

- Headline: wall_ms -23%, input_tokens -8%
- Improvements: `thinking:planning;bash:run-auth-tests;crypto:verify-token` dropped by 450ms (self-cost)
- No regressions above the 5% threshold
- Pattern diff: `redundant_crypto` resolved

A concerning result looks like:

- Headline: wall_ms -12%, but input_tokens +15%
- The optimization traded wall time for token cost — perhaps the caching logic requires more context to be passed to the LLM. The `regression_warnings` array will flag the input_tokens dimension.

---

## Scenario 2: CI regression checking

Use baselines as regression gates in CI pipelines. The idea: maintain a `release` baseline that represents the current known-good performance, and diff every PR against it.

**On the main branch, after a release:**

```
save_baseline({
  name: "v2.1-release",
  checkpoint: "release",
  commit: "abc123f"
})
```

Commit `.tracemeld/baselines/v2.1-release.baseline.json` to the repository.

**In a PR pipeline:**

1. Import the PR's profile data: `import_profile({ source: "path/to/pr-profile.json" })`
2. Diff against the release baseline: `diff_profile({ baseline: "v2.1-release", min_delta_pct: 10 })`
3. Check `regression_warnings` — if any dimension's total increased by more than your threshold, flag the PR.
4. Check `new_stacks` — new call paths may indicate feature additions (expected) or unintended new work (unexpected).

Because baselines are small JSON files (typically under 50KB), they're cheap to commit. A project might accumulate a few hundred KB of baseline history over dozens of releases — negligible.

---

## Scenario 3: Cross-session performance tracking

Track how your agent's performance evolves across multiple work sessions on the same codebase. Each session produces a baseline; over time, the collection tells a story.

**Naming convention:** Use task-descriptive names with a consistent pattern:

```
save_baseline({ name: "sprint-12-auth-before",  checkpoint: "before",  task: "Sprint 12: auth refactor" })
save_baseline({ name: "sprint-12-auth-after",   checkpoint: "after",   task: "Sprint 12: auth refactor" })
save_baseline({ name: "sprint-13-cache-before",  checkpoint: "before",  task: "Sprint 13: cache layer" })
save_baseline({ name: "sprint-13-cache-after",   checkpoint: "after",   task: "Sprint 13: cache layer" })
```

**To see what's available:** `list_baselines()` returns them sorted by creation date, most recent first.

**To compare across sessions:** Diff any baseline against any other. You're not limited to comparing sequential before/after pairs:

```
diff_profile({ baseline: "sprint-12-auth-before" })
```

This compares the *current* profile against the sprint 12 starting point — showing the cumulative impact of all work since then.

---

## Scenario 4: Multi-dimensional trade-off analysis

LLM agent profiling has a unique property: cost dimensions often trade off against each other. Using fewer tokens (cheaper) might require more tool calls (slower). Caching aggressively (faster) might use more memory (larger context).

The baseline workflow measures all dimensions simultaneously. When the diff shows an improvement in one dimension and a regression in another, you have a trade-off to reason about.

**Example interpretation:**

```
headline:
  wall_ms:       -340ms  (-18.2%)    ← faster
  input_tokens:  +2,100  (+11.4%)    ← more tokens
  cost_usd:      +$0.03  (+8.1%)     ← more expensive

regressions:
  thinking:planning;bash:npm test    input_tokens: +1,800 (+22.5%)

improvements:
  thinking:planning;bash:npm test    wall_ms: -340ms (-35.1%)
```

The same call stack shows up as both a regression (tokens) and an improvement (wall time). The optimization made `npm test` faster but needed more LLM reasoning to do it. Whether this trade-off is acceptable depends on the user's priorities — the diff gives you the data to make that call.

Use the `dimension` parameter to re-rank the diff by different cost dimensions:

```
diff_profile({ baseline: "my-baseline", dimension: "cost_usd" })
diff_profile({ baseline: "my-baseline", dimension: "wall_ms" })
```

The same underlying data, ranked by what matters most for each perspective.

---

## The optimization_loop prompt

For the full autonomous cycle, use the `optimization_loop` prompt. It encodes the complete workflow as a step-by-step sequence:

1. Save a "before" baseline with the task name
2. Run `profile_summary`, `bottleneck`, and `find_waste` to identify targets
3. Summarize the current state and what to optimize
4. Make the code changes
5. Re-profile the workload
6. Save an "after" baseline with the same task name
7. Diff against the "before" baseline
8. Synthesize: what improved, what regressed, net impact across all dimensions
9. If regressions exist, assess whether they're acceptable trade-offs

Use it by calling the prompt with a task description:

```
optimization_loop({ task: "reduce npm test wall time" })
```

---

## Integration with other tracemeld tools

The baseline workflow is most powerful when combined with tracemeld's analysis tools. Here's how they connect:

**`profile_summary` → `save_baseline`:** Profile summary gives you the headline numbers. If they look interesting (high cost, many errors), save a baseline before making changes.

**`bottleneck` + `hotspots` → optimization → `diff_profile`:** Bottleneck and hotspots tell you *where* to optimize. After you optimize, diff_profile tells you *whether* it worked — and whether it caused collateral regressions elsewhere.

**`find_waste` → optimization → `diff_profile` → `pattern_diff`:** Waste detection finds anti-patterns. After fixing them, the diff's `pattern_diff` field confirms they're resolved. If new patterns appear, you may have introduced new waste while fixing old waste.

**`export_profile` + `diff_profile`:** Export the current profile to speedscope or Perfetto UI for visual inspection, then use diff_profile for quantitative comparison. The visual tools show *shape* (call tree structure, parallelism, timeline); the diff shows *magnitude* (which stacks changed by how much).

**`list_baselines` → `diff_profile`:** When returning to a project after time away, list_baselines shows what measurement history exists. Pick the most relevant baseline and diff to understand how the current state compares.

---

## What the baseline digest contains

Understanding the digest structure helps you interpret diff results and debug unexpected outcomes.

**`frame_costs`** is the critical data structure. Each entry represents a unique call stack path — the same format as collapsed stacks, with semicolons separating ancestry frames. For a span `file_read:src/auth.ts` nested inside `bash:npm test` nested inside `thinking:planning`, the stack key is `thinking:planning;bash:npm test;file_read:src/auth.ts`.

Each frame_cost entry carries:
- `self_cost[]` — cost attributed directly to this frame, excluding children. Aligned to `value_types[]`.
- `total_cost[]` — cost including all children. Also aligned to `value_types[]`.
- `call_count` — how many times this exact stack path was observed.

The diff algorithm performs a full outer join on these stack keys. Stacks present in both baselines get delta computation. Stacks in only one side become `new_stacks` or `removed_stacks`.

**`kind_breakdown`** groups frames by their kind prefix (the part before `:` in frame names). A frame named `bash:npm test` has kind `bash`. This gives a high-level view: how much time was spent in bash commands vs. file reads vs. thinking vs. tool execution.

**`hotspots`** are pre-computed top-10 lists per dimension. They're included for quick comparison without running the full analysis — useful in CI where you want to check whether the top hotspot changed.

**`patterns`** are anti-patterns detected at capture time. The diff compares pattern sets and reports new vs. resolved patterns. A baseline that had 3 `retry_storm` detections and 1 `blind_edit`, compared against a current profile with 1 `retry_storm` and 1 `token_waste`, would show: resolved `blind_edit`, new `token_waste`, reduced `retry_storm` (though pattern counting is by name presence, not count).

---

## Practical tips

**Name baselines descriptively.** `before` and `after` are useless a week later. Use names that encode what the change was: `auth-cache-before`, `auth-cache-after`, `v2.1-release`, `fix-retry-storm-before`.

**Always save both before and after.** It's tempting to skip the "after" baseline and just look at the diff. But saving the after baseline means you can diff future changes against it — building a chain of measurements.

**Commit baselines for release checkpoints.** They're small enough (under 50KB typically) to live in your repository. Future sessions can diff against them without needing the original profile data.

**Use `min_delta_pct` to focus.** The default 5% threshold filters noise. For coarse-grained optimization work, raise it to 10% or 15%. For precision work (CI regression gates), lower it to 1% or 2%.

**Watch for normalization artifacts.** If two profiles have wildly different total costs (10x or more), normalization can amplify small absolute changes into large percentages. When the norm_factor is extreme, consider whether the profiles are truly comparable or whether the workloads diverged.

**Check `likely_refactoring` flags.** When a regression entry is flagged as likely refactoring, the diff engine determined that the parent stack's total cost was stable — meaning cost moved between sibling functions, not increased. Don't chase these as real regressions.

**Use the `performance_review` prompt for guided analysis.** It automatically checks for existing baselines and incorporates comparison when available. It's the easiest way to get a complete analysis that includes baseline context.

---

## File layout

```
project/
├── .tracemeld/
│   └── baselines/
│       ├── v2.0-release.baseline.json
│       ├── auth-refactor-before.baseline.json
│       ├── auth-refactor-after.baseline.json
│       └── sprint-13-cache-after.baseline.json
├── src/
│   └── ...
└── .gitignore          # optionally ignore .tracemeld/baselines/ if you
                        # don't want to commit measurement history
```

The `.tracemeld/baselines/` directory is created automatically by `save_baseline`. Each baseline is a standalone JSON file — no index, no database, no lock files. You can copy, move, delete, or commit them freely.
