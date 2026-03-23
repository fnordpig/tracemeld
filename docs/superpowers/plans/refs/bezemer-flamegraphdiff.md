# Reference: Bezemer's flamegraphdiff Triple-View Approach

Distilled from Cor-Paul Bezemer et al.'s SANER 2015 paper and the flamegraphdiff tool for use in tracemeld's `src/analysis/diff.ts` implementation. This document covers the triple-view design, the elided stacks problem it solves, linked highlighting, key paper findings, and how these ideas map to tracemeld's text-based DiffResult.

Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`

---

## 1. Triple-View Approach

The flamegraphdiff tool displays three synchronized flame graphs together in a single view:

- **Before (baseline)**: The original profile rendered as a standard flame graph at full fidelity. All stacks, all frame widths, all depths are preserved exactly as they appeared in the baseline capture. The viewer sees the complete "before" picture with no information loss.

- **After (comparison)**: The new profile rendered as a standard flame graph at full fidelity. Same treatment as the before view -- every stack is visible at its true width. The viewer sees the complete "after" picture independently.

- **Diff**: A color-coded delta view where frame widths are drawn from the after profile and colors encode the direction and magnitude of change. Red indicates regression (growth in cost), blue indicates improvement (shrinkage in cost), and color saturation is proportional to the magnitude of the delta relative to the maximum delta across all stacks. A fully saturated red frame is the single largest regression; a pale pink frame is a minor regression.

**The key insight**: showing all three views simultaneously gives the viewer complete context for interpreting the diff. Gregg's single differential flame graph (the approach tracemeld's companion ref doc `gregg-differential-flamegraphs.md` describes) presents only the diff view, which loses information about stacks that were removed between the two profiles. By always showing the before and after profiles alongside the diff, the triple-view ensures no information is lost -- the diff provides rapid visual scanning for regressions, while the before and after views provide the full context needed to interpret them.

---

## 2. Solving the Elided Stacks Problem

### 2.1 The Problem with Single-View Diff

Gregg's single differential flame graph draws frame widths from the **after** profile. This is a fundamental rendering decision: the SVG width of each frame rectangle is proportional to that frame's sample count in the after profile. The color encodes the delta (after minus before), but the geometry comes entirely from after.

The consequence: stacks that existed in the before profile but vanished entirely in the after profile have an after-count of zero. Zero width means zero pixels. These stacks are **invisible** in the differential flame graph. `difffolded.pl` correctly outputs them in its three-column format (e.g., `funcA;funcB;funcC 500 0`), but `flamegraph.pl` cannot render a zero-width rectangle.

This is not an edge case. Common scenarios that produce elided stacks:

- A function was optimized away or inlined, removing an entire call subtree
- A code path was deleted during refactoring
- A cache was added, eliminating a previously expensive computation
- A feature flag was toggled, disabling a code path
- An error-handling path that fired frequently in the before run did not fire in the after run

In all these cases, the viewer sees no indication that significant work was removed. The diff appears to show only regressions (red) and surviving improvements (blue on frames that still exist but shrank), creating a misleading picture.

### 2.2 The Triple-View Solution

The triple-view solves this by always showing the before profile separately at full fidelity. Removed stacks remain visible at their original size in the before view. The viewer can:

1. Scan the diff view for regressions (red frames)
2. Notice stacks present in the before view but absent in the after view
3. Cross-reference between all three views to build a complete understanding

### 2.3 Tracemeld's Text-Based Equivalent

Tracemeld is an MCP server producing structured text output for LLM consumption, not SVG flame graphs. The equivalent of the triple-view for tracemeld's `diff_profile` tool is returning three distinct sections in the DiffResult:

- **before_summary**: Aggregate statistics from the baseline profile (total cost per dimension, top frames by cost, stack count). This is the text equivalent of the "before" flame graph -- it gives the LLM the full baseline context.

- **after_summary**: Aggregate statistics from the comparison profile. The text equivalent of the "after" flame graph.

- **diff section**: The `headline`, `regressions`, and `improvements` arrays. This is the text equivalent of the color-coded diff flame graph.

Additionally, the DiffResult should include explicit `removed_stacks` and `new_stacks` arrays. These directly solve the elided stacks problem: `removed_stacks` lists every stack that appeared in the baseline but is absent from the comparison profile, with its before-cost. `new_stacks` lists every stack that appeared in the comparison but is absent from the baseline, with its after-cost. The LLM can then reason about both what grew and what vanished.

---

## 3. Linked Highlighting

In the flamegraphdiff web interface, mousing over any frame in any of the three views highlights the corresponding frame across all three views simultaneously. If the user hovers over `funcA;funcB;funcC` in the before view, the same stack path lights up in the after view (if it exists) and in the diff view (if it has nonzero width).

This linked highlighting enables rapid cross-referencing:

- Hover a large frame in the before view to see whether it still exists in the after view and what its delta is in the diff view
- Hover a deeply red frame in the diff view to see its absolute size in both the before and after views, understanding whether a +50% regression is on a frame that was already large (significant) or one that was tiny (negligible in absolute terms)
- Hover a frame in the after view to see whether it existed at all in the before view (new code path) or whether it grew from a smaller presence

The linking mechanism operates on exact frame-path string matching: the full semicolon-delimited ancestry from root to the hovered frame must match across views.

Gregg noted that flamegraphdiff can be "a bit slow for complex profiles with many frames, as it is more than doubling the number of rectangles to draw." This performance concern is irrelevant for tracemeld's text-based approach, where the cost is in computing the diff data structure rather than rendering SVG.

### 3.1 Tracemeld's Text-Based Equivalent

For text-based MCP output, linked highlighting is not possible. The equivalent is **consistent frame naming across all sections of the DiffResult**. When a frame appears in `before_summary`, `after_summary`, `regressions`, `improvements`, `removed_stacks`, or `new_stacks`, it must use the identical `{kind}:{detail}` name and identical semicolon-delimited stack path. This consistency enables the LLM to cross-reference entries across sections -- the LLM's "linking" is string matching across the structured response, which requires deterministic naming.

The `FrameTable` in tracemeld's canonical model already enforces frame deduplication by name, so this consistency is architecturally guaranteed as long as the diff algorithm uses frame names from the FrameTable rather than constructing ad-hoc strings.

---

## 4. SANER 2015 Paper Key Findings

**Full citation**: Cor-Paul Bezemer, Johan Pouwelse, and Brendan Gregg. "Understanding Software Performance Regressions using Differential Flame Graphs." Proceedings of the 22nd IEEE International Conference on Software Analysis, Evolution, and Reengineering (SANER), ERA Track, 2015. DOI: 10.1109/SANER.2015.7081872.

### 4.1 Authors and Context

- **Cor-Paul Bezemer**: Performance engineering researcher, Delft University of Technology (later University of Alberta). Primary author of the flamegraphdiff tool and the triple-view concept. Gregg acknowledged that "Cor-Paul Bezemer researched differential flame graphs and developed the first solution."
- **Johan Pouwelse**: Distributed systems researcher at Delft University of Technology, lead of the Dispersy/Tribler projects used as the case study.
- **Brendan Gregg**: Performance engineer at Netflix, creator of the original flame graph and the single-view differential flame graph (`difffolded.pl`).

The paper was published at the ERA (Early Research Achievements) track of SANER 2015, indicating it presents a promising technique with initial validation rather than a comprehensive empirical study.

### 4.2 Key Findings

1. **Differential flame graphs effectively identify performance regressions in large-scale systems.** The authors applied their tool to real performance regressions in the Dispersy peer-to-peer synchronization system. The differential visualization pinpointed the specific functions responsible for regressions that would have been difficult to find through traditional profiling alone.

2. **The triple-view significantly improves understanding compared to side-by-side comparison or a single diff view.** With only a diff view (Gregg's approach), removed stacks are invisible and the viewer lacks context for the absolute magnitude of changes. With side-by-side before/after views (no diff), the viewer must mentally compute deltas across two complex hierarchical visualizations. The triple-view combines the strengths of both approaches.

3. **Case study -- Dispersy evaluation metrics.** The paper evaluated DFG-sets on Dispersy, a decentralized message synchronization system used in the Tribler peer-to-peer client:
   - Test suite coverage: 73%
   - Each test suite run: approximately 10 minutes
   - Full experiment (200 revisions, 5 iterations): approximately 7 days of continuous execution
   - Average distinct stack traces per execution: 130
   - Average stack trace depth: 9 frames
   - Field user study result: participants correctly analyzed and diagnosed 3 out of 4 performance phenomena using the DFG-set approach

4. **Automated regression detection benefits from combining visual and quantitative approaches.** The paper argues that purely quantitative approaches (threshold-based alerts on aggregate metrics) miss regressions that are visible in the flame graph structure -- for example, a function that doubled in cost but represents a small fraction of total runtime might not trigger a global threshold but is clearly visible as a saturated-red frame in the diff view.

5. **The color-coding scheme (red/blue with proportional saturation) is effective for rapid triage.** Users can quickly scan the diff view for the most saturated frames, which represent the largest deltas. This is faster than reading tabular diff output, though for LLM consumers (tracemeld's use case), structured tabular output sorted by delta magnitude achieves the same effect.

6. **Performance visualization research gap.** The paper noted that performance regression analysis through visualization had received "surprisingly little attention" in research. Prior work was limited: OProfile offered purely textual differential profiles expressing differences in percentage; Bergel et al. proposed a visual profiler for Pharo using element sizing to encode execution time and call count; Alcocer extended Bergel's approach with callgraph reduction.

7. **Proposed application domains beyond single-application regression.** The paper proposes DFGs for distributed/parallel computing (comparing workload distribution across nodes), algorithm analysis (comparing different implementations of the same distributed algorithm), and performance fix validation (confirming targeted fixes without introducing regressions elsewhere).

### 4.3 Normalization

The paper emphasizes that normalization is essential when comparing profiles of different durations or workloads. Raw sample counts are misleading without it. The approach (matching `difffolded.pl -n`) normalizes by scaling all before-profile counts by `total_after / total_before`, so a delta of zero means "same proportion of total work," not "same absolute count." This is critical for tracemeld's use case: an LLM agent's "before" session might be 30 seconds and the "after" might be 60 seconds. Without normalization, every stack would falsely appear as a regression.

### 4.4 Tool Implementation

FLAMEGRAPHDIFF is implemented in Perl (56.7%), HTML (18.0%), Python (17.8%), and Shell (7.5%). It takes two collapsed-stack files as input (the same `stack COUNT` format used by `difffolded.pl`), generates three flame graph SVGs via the `generate.sh` pipeline, and combines them into an interactive HTML page with JavaScript-based linked highlighting. Gregg's FlameGraph repository is included as a git submodule.

### 4.5 Combining Approaches

Gregg suggested that the various differential approaches could be combined: "My red/blue flame graphs, Robert's hue differential, and Cor-Paul's triple-view, all have their strengths." He proposed using diff1.svg and diff2.svg for the top two flame graphs in Cor-Paul's layout, with the bottom flame graph colored using Robert's blue-to-white-to-red palette. For tracemeld's text output, this translates to including both per-entry delta direction indicators (analogous to red/blue) and the structural triple-view (before/after/diff sections) in every response.

### 4.6 Paper Links

- **Paper PDF**: http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf
- **IEEE Digital Library**: http://ieeexplore.ieee.org/xpl/articleDetails.jsp?arnumber=7081872

---

## 5. Application to Tracemeld's DiffResult

The DiffResult type (to be implemented in `src/analysis/diff.ts`) should mirror the triple-view concept in its structure. Each conceptual "view" maps to specific fields in the return value:

### 5.1 Diff View = `headline` + `regressions` + `improvements`

The `headline` section provides the equivalent of the diff view's top-level summary: total cost change per dimension, expressed as both absolute delta and percentage. For example: "wall_time: +1200ms (+15%), tokens: +340 (+8%)".

The `regressions` array lists frames whose cost increased, ranked by absolute delta descending. Each entry includes the frame's stack path, before cost, after cost, absolute delta, and percentage change per dimension. This is the text equivalent of scanning for red frames in the diff view.

The `improvements` array lists frames whose cost decreased, using the same structure. Text equivalent of blue frames.

### 5.2 Before/After Views = Summary Statistics

The DiffResult should include `before_summary` and `after_summary` fields providing aggregate statistics from each profile:

- Total cost per dimension (e.g., total wall time, total tokens)
- Number of unique stacks
- Top N frames by total cost
- Profile metadata (name, capture timestamp, session duration)

These fields give the LLM the same contextual grounding that the before and after flame graph views provide to a human viewer. Without them, the LLM sees only deltas and cannot assess whether a +50% regression on a frame is significant (frame was 30% of total) or negligible (frame was 0.1% of total).

### 5.3 Elided Stacks = `new_stacks` + `removed_stacks`

These two arrays explicitly solve the elided stacks problem:

- **`removed_stacks`**: Stacks present in the baseline but absent from the comparison. Each entry includes the stack path and the before-cost per dimension. These are the stacks that would be invisible in Gregg's single diff view. For tracemeld, they are potentially the most important entries: a stack that vanished entirely might indicate a successfully optimized code path (good) or accidentally deleted functionality (bad). The LLM needs to see them to make that determination.

- **`new_stacks`**: Stacks present in the comparison but absent from the baseline. Each entry includes the stack path and the after-cost per dimension. These represent new code paths, new features, or newly triggered error handling.

Both arrays should be sorted by cost descending so the most expensive removed/added stacks appear first.

### 5.4 Consistent Frame Naming Across Sections

Per the linked highlighting discussion (Section 3), all sections of the DiffResult must use identical frame names and stack paths. A frame that appears in `removed_stacks` as `llm_call:claude-3-opus;tool_use:file_read` must use that exact string if it also appears in `before_summary`'s top-frames list. This consistency is what enables the LLM to cross-reference across sections, functioning as the text equivalent of linked highlighting.

---

## 6. Additional References

### flamegraphdiff Tool

- **Project page**: https://corpaul.github.io/flamegraphdiff/
- **Live demo (Dispersy case study)**: http://corpaul.github.io/flamegraphdiff/demos/dispersy/dfg-set.html
- **GitHub repository**: https://github.com/corpaul/flamegraphdiff

### Gregg's Original Differential Flamegraph

Bezemer's triple-view extends Gregg's single-view differential flame graph. The companion reference distillation covering Gregg's algorithm in detail is at `docs/superpowers/plans/refs/gregg-differential-flamegraphs.md`.

- **Gregg's blog post**: https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html

### Related Tracemeld Documents

- **Parent planning doc**: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`
- **Gregg differential flamegraph reference**: `docs/superpowers/plans/refs/gregg-differential-flamegraphs.md`
- **FBDetect regression detection reference**: `docs/superpowers/plans/refs/fbdetect-regression-detection.md`

---

## Sources

- [Bezemer, Pouwelse, Gregg. "Understanding Software Performance Regressions using Differential Flame Graphs." IEEE SANER 2015 (ERA track)](http://asgaard.ece.ualberta.ca/papers/Conference/SANER_2015_Bezemer_Understanding_Software_Performance_Regressions_using_Differential_Flame_Graphs.pdf)
- [IEEE Digital Library entry (DOI: 10.1109/SANER.2015.7081872)](http://ieeexplore.ieee.org/xpl/articleDetails.jsp?arnumber=7081872)
- [flamegraphdiff tool](https://corpaul.github.io/flamegraphdiff/)
- [flamegraphdiff GitHub repository](https://github.com/corpaul/flamegraphdiff)
- [flamegraphdiff live demo (Dispersy)](http://corpaul.github.io/flamegraphdiff/demos/dispersy/dfg-set.html)
- [Differential Flame Graphs (Gregg, 2014-11-09)](https://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html)
- [The Flame Graph (Gregg, ACM Queue 2016)](https://queue.acm.org/detail.cfm?id=2927301)
- [SANER 2015 slide deck](https://www.slideshare.net/corpaulbezemer/saner-2015-era-track)
- [Bezemer, Pouwelse. "Detecting and Analyzing I/O Performance Regressions." JSEP 2014 (earlier Dispersy I/O regression work)](https://azaidman.github.io/publications/bezemerJSEP2014.pdf)
- [Cor-Paul Bezemer's publication page](https://www.ece.ualberta.ca/~bezemer/)
- [ResearchGate entry for the SANER 2015 paper](https://www.researchgate.net/publication/282681970_Understanding_software_performance_regressions_using_differential_flame_graphs)
