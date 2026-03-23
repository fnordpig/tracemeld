# Reference: Gregg's Differential Flamegraph Algorithm

Distilled from Brendan Gregg's tooling and writings for use in tracemeld's `src/analysis/diff.ts` implementation. This document covers the algorithm, data structures, normalization, percentage formula, and known limitations.

Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`

---

## 1. The Collapsed Stack Format

The entire differential flamegraph pipeline operates on the "folded" (collapsed) stack format, an intermediate text representation produced by `stackcollapse-*.pl` scripts.

**Format**: One line per unique stack, semicolon-delimited frames (root-to-leaf), followed by a space and a sample count:

```
root_func;parent_func;leaf_func 42
```

**Properties**:
- Frames are ordered root-to-leaf (bottom-to-top of the call stack)
- The count is a positive integer or decimal
- Identical stacks from different samples are pre-aggregated (summed) into a single line
- The format is agnostic to the profiler that produced it; converters exist for perf, DTrace, pmcstat, jstack, etc.

**Tracemeld mapping**: The `BaselineDigest.frame_costs[]` array is tracemeld's equivalent of the collapsed format. Each entry has a `stack` field (semicolon-joined frame ancestry `root;parent;child`) and multi-dimensional cost vectors (`self_cost: number[]`, `total_cost: number[]`). The collapsed exporter at `src/exporters/collapsed.ts` already produces single-dimension collapsed output.

---

## 2. The `difffolded.pl` Algorithm

Source: [difffolded.pl](https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl) (approximately 115 lines of Perl).

### 2.1 Pseudocode

```
Input:  file1 (before profile, collapsed format)
        file2 (after profile, collapsed format)
Flags:  -n (normalize), -s (strip hex addresses)
Output: three-column collapsed format: "stack count1 count2"

# --- Phase 1: Ingest ---

Folded = {}          # hash of hash: Folded[stack][file_num] = count
total1 = 0
total2 = 0

for each line in file1:
    (stack, count) = regex_parse(line)       # /^(.*)\s+?(\d+(?:\.\d*)?)$/
    if strip_hex: stack = strip_hex_addrs(stack)
    Folded[stack][1] += count
    total1 += count

for each line in file2:
    (stack, count) = regex_parse(line)
    if strip_hex: stack = strip_hex_addrs(stack)
    Folded[stack][2] += count
    total2 += count

# --- Phase 2: Full outer join + normalize ---

for each stack in keys(Folded):
    Folded[stack][1] //= 0     # default missing stacks to 0
    Folded[stack][2] //= 0

    if normalize and total1 != total2:
        Folded[stack][1] = int(Folded[stack][1] * total2 / total1)

    print "$stack $Folded[stack][1] $Folded[stack][2]\n"
```

### 2.2 Data Structures

| Variable | Type | Purpose |
|----------|------|---------|
| `%Folded` | `Map<string, {1: number, 2: number}>` | Per-stack counts from each file |
| `$total1` | `number` | Sum of all counts in file 1 |
| `$total2` | `number` | Sum of all counts in file 2 |

### 2.3 Output Format

Three-column: `stack before_count after_count`. Example:

```
funcA;funcB;funcC 31 33
funcA;funcD 15 0
funcA;funcE 0 8
```

This output is piped directly to `flamegraph.pl`, which detects the two-column format and enters differential mode.

---

## 3. How `flamegraph.pl` Processes the Diff

Source: [flamegraph.pl](https://github.com/brendangregg/FlameGraph/blob/master/flamegraph.pl).

### 3.1 Two-Column Detection and Delta Computation

When `flamegraph.pl` encounters input with two numeric columns, it parses them as `samples` (before, column 1) and `samples2` (after, column 2):

```perl
$delta = $samples2 - $samples;          # after - before
$maxdelta = abs($delta) if abs($delta) > $maxdelta;
```

**Frame widths** are drawn from the **after** count (`samples2`). This means stacks that were removed entirely (after=0) have zero width and are invisible in the SVG output.

### 3.2 Color Scheme

The `color_scale` function maps delta magnitude to color:

```perl
sub color_scale {
    my ($value, $max) = @_;
    my ($r, $g, $b) = (255, 255, 255);    # start white
    $value = -$value if $negate;
    if ($value > 0) {
        $g = $b = int(210 * ($max - $value) / $max);  # red
    } elsif ($value < 0) {
        $r = $g = int(210 * ($max + $value) / $max);   # blue
    }
    return "rgb($r,$g,$b)";
}
```

| Delta | Color | Meaning |
|-------|-------|---------|
| Positive (more samples) | Red shades | Regression / growth |
| Negative (fewer samples) | Blue shades | Improvement / reduction |
| Zero | White | No change |
| `--negate` flag | Inverts red/blue | Swaps interpretation |

Saturation is proportional to `abs(delta) / maxdelta` across all stacks, so the hottest regression is fully saturated red.

### 3.3 Percentage Display Formula

```perl
my $d = $negate ? -$delta : $delta;
my $deltapct = sprintf "%.2f", ((100 * $d) / ($timemax * $factor));
```

Where:
- `$d` = delta, optionally sign-flipped by `--negate`
- `$timemax` = total sample count of the after profile (the root frame width)
- `$factor` = scaling factor (default 1)

This computes: **what percentage of the total after-profile does this delta represent?** It is NOT the per-function percentage change. A function going from 6 to 7 samples in a 100-sample after-profile shows `+1.00%`, meaning "this function's growth accounts for 1% of the total profile."

---

## 4. The Percentage Formula Controversy (Issue #170)

Source: [GitHub Issue #170](https://github.com/brendangregg/FlameGraph/issues/170). Status: open/unresolved.

### 4.1 The Problem

The tooltip in `flamegraph.pl` displays a per-function delta percentage. A user observed that a function going from 6 samples (before) to 7 samples (after) displays `+14.29%`, not `+16.67%`.

### 4.2 The Two Formulas

| Formula | Computation | Result for 6->7 | Denominator meaning |
|---------|------------|-----------------|---------------------|
| `(new - old) / old * 100` | `(7-6)/6 * 100` | **+16.67%** | "How much did this grow relative to its original size?" |
| `(new - old) / new * 100` | `(7-6)/7 * 100` | **+14.29%** | "What fraction of the current value is attributable to growth?" |

`flamegraph.pl` uses `(new - old) / new` (the after-denominator form). The rationale: frame widths are drawn from the after profile, so the percentage represents what fraction of the displayed width is due to the change.

The standard mathematical/financial convention is `(new - old) / old`, which measures change relative to baseline.

### 4.3 Tracemeld Decision

The roadmap specifies implementing **both** formulas, selectable via a `pct_base` parameter:
- `"after"` (default, matching `flamegraph.pl`): `delta_pct = (after - before) / after * 100`
- `"before"` (intuitive/standard): `delta_pct = (after - before) / before * 100`

**Edge cases**:
- `before = 0` (new stack): `delta_pct_of_before` is undefined; report as `+Infinity` or a sentinel like `"new"`
- `after = 0` (removed stack): `delta_pct_of_after` is undefined; report as `-Infinity` or a sentinel like `"removed"`
- Both zero: no-op, skip

Note: The `deltapct` displayed in `flamegraph.pl`'s tooltip (Section 3.3 above) is a *third* formula: `delta / total_after * 100`, which measures the delta's share of the entire profile, not the per-function change. Tracemeld should compute all three: `delta_pct_of_before`, `delta_pct_of_after`, and `delta_pct_of_total`.

---

## 5. Normalization

### 5.1 The Problem

If the before profile ran for 30 seconds under light load (10,000 total samples) and the after profile ran for 60 seconds under heavy load (40,000 total samples), every stack will appear to have grown 4x. The diff is meaningless without normalization.

### 5.2 The `difffolded.pl -n` Algorithm

```
norm_factor = total2 / total1
for each stack:
    Folded[stack][1] = int(Folded[stack][1] * norm_factor)
```

This scales file1 (before) counts so that `sum(all_before_counts) == sum(all_after_counts)`. After normalization, a delta of zero means "same proportion of total work," not "same absolute count."

### 5.3 Normalization Is Linear

The scaling is linear and uniform across all stacks. This is a simplifying assumption. Gregg notes normalization is "complicated" and linear scaling "is going to have some issues." It works well when:
- The workload shape is similar but duration/load differs
- You are comparing the same server under different traffic volumes

It works poorly when:
- The workload composition fundamentally changed (e.g., different request mix)
- One profile includes startup/shutdown phases that the other doesn't

### 5.4 Tracemeld Implementation

The roadmap specifies normalizing by default (since LLM agent sessions naturally vary in duration), with an option to disable. The normalization operates per-dimension: for each value type index `dim`, compute `norm_factor[dim] = total_after[dim] / total_before[dim]`, then scale all `before.frame_costs[].self_cost[dim]` and `before.frame_costs[].total_cost[dim]` by that factor.

---

## 6. Limitations and Pitfalls

### 6.1 Elided (Invisible) Stacks

The most significant limitation of visual differential flamegraphs. Stacks that exist in the before profile but vanish entirely in the after profile have `after_count = 0`, meaning zero width in the SVG. They are **invisible** in the flamegraph despite being potentially important (a function was removed or optimized away entirely).

`difffolded.pl` correctly outputs these stacks (with `count2 = 0`), but `flamegraph.pl` cannot render zero-width frames.

**Tracemeld advantage**: As a text-based MCP tool, tracemeld has no rendering constraint. The diff result should include a dedicated `removed_stacks` array listing stacks that were present in the baseline but absent in the current profile, with their before-cost.

### 6.2 Visual-Only Diff

Gregg's original toolchain produces only a visual artifact (SVG). There is no structured data output, no machine-readable diff, no API. The human must visually scan for red/blue regions. Tracemeld's `diff_profile` tool produces structured JSON with ranked regressions and improvements, solving this limitation.

### 6.3 No Statistical Significance

Neither `difffolded.pl` nor `flamegraph.pl` performs any statistical test. A stack going from 1 to 2 samples shows as a +100% regression with the same visual weight as a stack going from 1000 to 2000. In low-sample profiles (common for LLM agent sessions with dozens, not thousands, of spans), this can produce noisy results.

**Mitigation in tracemeld**: The `min_delta_pct` threshold (default 5%) filters noise. For richer analysis, the roadmap references FBDetect's variance-reduction technique: per-function gCPU (`samples_containing_func / total_samples`) is more stable than absolute counts because variance is reduced by a factor of approximately k (number of unique functions).

### 6.4 Stack Identity Fragility

The diff operates on exact string matching of semicolon-joined stack paths. If a function is renamed, or if a parent frame changes (e.g., inlining, refactoring), the before and after stacks won't match. The before stack appears as "removed" and the after stack appears as "new," obscuring that the underlying work is the same.

**Mitigation**: The cost-shift filter from FBDetect (Section 3 of the SOSP 2024 paper): if a child function's gCPU changes but the parent's total gCPU is stable, flag the change as `likely_refactoring` rather than a true regression.

### 6.5 Single-Dimension Only

`difffolded.pl` operates on a single count column. There is no native support for multi-dimensional values (e.g., wall time + token count + API cost simultaneously). Tracemeld extends the algorithm to multi-dimensional profiling by iterating the diff computation across each dimension in `Profile.value_types[]`.

---

## 7. CPI Flame Graphs: Differential Across Counter Types

Source: [CPI Flame Graphs blog post](https://www.brendangregg.com/blog/2014-10-31/cpi-flame-graphs.html) (October 31, 2014).

CPI (Cycles Per Instruction) flame graphs were the first use of `difffolded.pl`, predating the regression-comparison use case. Instead of comparing before/after profiles of the same counter, Gregg compared two different hardware counter profiles captured simultaneously:

- **File 1**: CPU instruction counts per stack
- **File 2**: CPU cycle counts per stack

The diff colors each function by its CPI ratio: high CPI (blue) = stalled/memory-bound, low CPI (red) = compute-bound. The `-n` normalization flag is essential here because instruction counts and cycle counts have fundamentally different scales.

**Relevance to tracemeld**: This demonstrates that the diff algorithm is not limited to before/after comparisons of the same metric. It can compare any two value dimensions within a single profile. Tracemeld could support a `cross_dimension_diff` mode that compares, e.g., wall-clock time vs. token count to identify functions where token cost is disproportionate to time spent.

---

## 8. Bezemer's Triple-View Alternative

Source: [flamegraphdiff](https://corpaul.github.io/flamegraphdiff/), Bezemer, Pouwelse, Gregg, "Understanding software performance regressions using differential flame graphs," IEEE SANER 2015.

Cor-Paul Bezemer's `flamegraphdiff` addresses the context problem by showing three linked flame graphs simultaneously: before, after, and diff. Mouseover on any frame highlights the corresponding frame in all three views, providing full context.

**Relevance to tracemeld**: For text-based MCP output, the equivalent is returning before summaries, after summaries, and the diff in a single structured response, so the LLM has all three views to reason about. The roadmap specifies this in the `diff_profile` return value structure.

---

## 9. Summary: What the Implementer Needs

For `src/analysis/diff.ts`, the core algorithm is:

1. **Ingest** two `BaselineDigest` objects (or one digest + the live profile converted to digest form).
2. **Normalize** per-dimension: `before.cost[dim] *= total_after[dim] / total_before[dim]` for every frame_cost entry.
3. **Full outer join** on `frame_costs[].stack` (exact string match, semicolon-delimited).
4. **Compute deltas** per stack per dimension:
   - `delta = after - before` (absolute change)
   - `delta_pct_of_before = delta / before * 100` (standard % change)
   - `delta_pct_of_after = delta / after * 100` (flamegraph.pl convention)
   - `delta_pct_of_total = delta / total_after * 100` (share of total profile)
5. **Apply cost-shift filter**: Check if parent stack's total cost also changed; if not, flag as `likely_refactoring`.
6. **Classify**: Partition into `regressions` (delta > 0), `improvements` (delta < 0), `new_stacks` (before = null), `removed_stacks` (after = null).
7. **Rank and cap**: Sort by absolute delta descending, filter by `min_delta_pct`, cap at top N per category.
8. **Return** structured result with headline comparison, per-dimension totals, ranked changes, and metadata.

---

## Sources

- [Differential Flame Graphs (Gregg, 2014-11-09)](https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html)
- [difffolded.pl source](https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl)
- [flamegraph.pl source](https://github.com/brendangregg/FlameGraph/blob/master/flamegraph.pl)
- [Issue #170: Percentage formula](https://github.com/brendangregg/FlameGraph/issues/170)
- [Flame Graphs overview (Gregg)](https://www.brendangregg.com/flamegraphs.html)
- [The Flame Graph, ACM Queue 14(2), 2016](https://queue.acm.org/detail.cfm?id=2927301)
- [CPI Flame Graphs (Gregg, 2014-10-31)](https://www.brendangregg.com/blog/2014-10-31/cpi-flame-graphs.html)
- [flamegraphdiff (Bezemer)](https://corpaul.github.io/flamegraphdiff/)
- [Bezemer, Pouwelse, Gregg. "Understanding software performance regressions using differential flame graphs." IEEE SANER 2015](http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf)
- [FBDetect: Subroutine-level regression detection (SOSP 2024)](https://tangchq74.github.io/FBDetect-SOSP24.pdf)
