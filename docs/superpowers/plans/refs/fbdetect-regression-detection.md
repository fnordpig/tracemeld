# FBDetect: Regression Detection Techniques for tracemeld's `diff_profile`

> Distilled reference for tracemeld implementers. Covers the subset of FBDetect
> (Meta, SOSP 2024 Best Paper) relevant to tracemeld's diff engine, translated
> from hyperscale fleet profiling to single-agent LLM session comparison.
>
> Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`

---

## 1. Source Material

| # | URL | Status | Content Used |
|---|-----|--------|--------------|
| 1 | https://tangchq74.github.io/FBDetect-SOSP24.pdf | 403 (paywalled PDF); content recovered via search indices and summaries | gCPU definition, variance reduction model, cost shift algorithm, CUSUM details |
| 2 | https://dl.acm.org/doi/10.1145/3694715.3695977 | 403; metadata recovered via ACM listing and web search | Formal citation, author list, venue confirmation (SOSP '24 Best Paper) |
| 3 | https://dl.acm.org/doi/pdf/10.1145/3785504 | 403; partial content via search | Extended version (ACM TOCS 2025), combines FBDetect with ServiceLab |
| 4 | https://sigops.org/s/conferences/sosp/2024/accepted.html | 403; content recovered via web search | Confirmed paper in SOSP 2024 accepted list |

**Full citation**: Dong Young Yoon, Yang Wang, Miao Yu, Xu Huang, Juan Ignacio Jones, Abhinay Kukkadapu, Osman Kocas, Jonathan Wiepert, Kapil Goenka, Sherry Chen, Yanjun Lin, Zhihui Huang, Jocelyn Kong, Michael Chow, and Chunqiang Tang. "FBDetect: Catching Tiny Performance Regressions at Hyperscale through In-Production Monitoring." In *Proceedings of the ACM SIGOPS 30th Symposium on Operating Systems Principles (SOSP '24)*, Austin, TX, November 2024.

---

## 2. The gCPU Metric

### 2.1 Definition

For subroutine A, **gCPU_A** (globally-aggregated CPU) is the fraction of total stack-trace samples in which subroutine A appears:

```
gCPU_A = samples_containing_A / total_samples
```

If 100 stack-trace samples are collected for a service and subroutine `foo` appears in 8 of them, `gCPU_A(foo) = 8%`. The paper prefers gCPU over raw CPU time (X_A) because gCPU is directly computable from periodic stack-trace sampling without per-function instrumentation.

Changes are expressed in both absolute and relative terms: a gCPU change from 1% to 1.1% is a **0.1% absolute** change and a **10% relative** change.

### 2.2 Computing gCPU from tracemeld's `frame_costs`

Tracemeld's `BaselineDigest.frame_costs[]` stores per-stack entries with `total_cost[]` values across dimensions. The mapping is direct:

```typescript
// For a given dimension index `dim`:
const totalAllCosts = frame_costs.reduce((sum, fc) => sum + fc.self_cost[dim], 0);

// gCPU for a specific frame_cost entry:
const gCPU = fc.total_cost[dim] / totalAllCosts;
```

Key distinction: `total_cost` includes the frame and all its descendants (inclusive/total), while `self_cost` is exclusive. gCPU in FBDetect corresponds to **total_cost** semantics -- a subroutine's gCPU includes time spent in its callees, matching what a stack-trace sampler captures (every frame on the stack gets credit for the sample).

For tracemeld's diff engine, the relevant comparison is:

```
delta_gCPU(frame) = gCPU_after(frame) - gCPU_before(frame)
```

This is computed after normalization (see Section 5 of the roadmap's diff algorithm), so different session durations do not bias the comparison.

---

## 3. Variance Reduction: Subroutine-Level vs. Process-Level

### 3.1 The Core Insight

FBDetect's central contribution is demonstrating that measuring at the **subroutine level** rather than the **process level** reduces variance by orders of magnitude, enabling detection of much smaller regressions.

Under a simplified model where a process comprises *k* subroutines with independent CPU usage:

```
Var(X_process) = k * Var(X_subroutine)
```

Therefore:

```
Var(X_subroutine) ~ Var(X_process) / k
```

The variance reduction factor is approximately *k*. At Meta's serverless platform, the median gCPU of non-trivial subroutines is **0.0083%**, yielding **k = 1/0.0083% = 12,048**. This massive k reduces sigma-squared by 100--10,000x, allowing detection of regressions as small as 0.005% within hours.

### 3.2 Why It Works Despite Violated Assumptions

Subroutines are not truly IID -- they have correlated execution patterns, shared resources, and hierarchical call relationships. The paper acknowledges this but demonstrates empirically that the variance reduction principle holds in practice: process-level variance decomposes across subroutines, and even with correlations, the per-subroutine variance is much smaller.

### 3.3 Adaptation to tracemeld

Tracemeld profiles LLM agent sessions, not fleet-wide services. Key differences:

| Dimension | FBDetect (Meta fleet) | tracemeld (LLM agent) |
|---|---|---|
| Sample count | Millions of servers, continuous sampling | Single session, dozens to hundreds of spans |
| k (subroutine count) | ~12,000 | ~20--200 unique frames |
| Baseline stability | Fleet aggregation smooths noise | Comparison of two discrete sessions |
| Detection threshold | 0.005% | ~5% (practical minimum) |

**What tracemeld borrows**: The principle that per-frame gCPU is a more stable comparison metric than total session cost. When an agent session goes from 45s to 50s total, the 11% increase is noisy (maybe the LLM was slower, maybe the network had a hiccup). But if `file_read:src/auth.ts` went from 2% gCPU to 8% gCPU, that is a clear, isolated signal.

**What tracemeld does NOT need**: Fleet aggregation, time-series monitoring, seasonality decomposition, or multi-day sample collection. Tracemeld compares two point-in-time baseline digests, not continuous time series.

---

## 4. Cost Shift Detection (False Positive Filtering)

### 4.1 The Problem

34% of subroutine-level regressions detected by FBDetect are **false positives caused by cost shifts**. A cost shift occurs when code refactoring moves execution cost between subroutines without changing the aggregate cost. For example:

- Before: function `A` does work X and calls `B` for work Y
- After refactoring: function `A` now also does work Y inline, and `B` is removed or reduced

Subroutine `A` shows a regression (its gCPU increased), but the combined cost of `A + B` is unchanged. This is a code reorganization, not a performance regression.

### 4.2 FBDetect's Algorithm

FBDetect filters cost shifts by examining **higher-level cost domains**: the parent caller or encapsulating class of the subroutine showing a regression.

The algorithm:

1. Detect a regression in subroutine C (child).
2. Look up the **parent cost domain** -- either the direct caller in the call stack, or the class/module containing C.
3. Compare the parent's total gCPU before and after the change.
4. **If the parent's total gCPU change is negligible** (below a threshold), classify C's regression as a **cost shift** (false positive) rather than a true regression.

The intuition: if code moved from sibling B to child C but the parent A's total cost is stable, the work was merely redistributed within A's subtree.

### 4.3 tracemeld's Implementation

The roadmap specifies this algorithm for `diff_profile` (roadmap line 370):

```
For each regression, check whether the parent stack (stack minus the leaf
frame) also regressed. If parent total cost delta is within +/-2%, flag
as `likely_refactoring`.
```

In terms of the `frame_costs` data structure, where stacks are semicolon-joined ancestry chains (`root;parent;child`):

```typescript
function isCostShift(
  childStack: string,           // e.g. "bash:npm;file_read:src/auth.ts;parse:json"
  childDeltaPct: number,        // e.g. +15%
  frameCostsBefore: Map<string, FrameCost>,
  frameCostsAfter: Map<string, FrameCost>,
  threshold: number = 2.0       // percent
): boolean {
  // Extract parent stack by removing the leaf frame
  const parts = childStack.split(';');
  if (parts.length < 2) return false;  // root frame, no parent to check
  const parentStack = parts.slice(0, -1).join(';');

  const parentBefore = frameCostsBefore.get(parentStack)?.total_cost[dim] ?? 0;
  const parentAfter = frameCostsAfter.get(parentStack)?.total_cost[dim] ?? 0;

  // Normalize parentBefore by the same norm_factor used for the diff
  const parentDeltaPct = parentBefore === 0
    ? (parentAfter > 0 ? Infinity : 0)
    : ((parentAfter - parentBefore) / parentBefore) * 100;

  // If parent total cost barely changed, child's regression is a cost shift
  return Math.abs(parentDeltaPct) <= threshold;
}
```

When this returns `true`, the diff entry should include `"likely_refactoring": true` and a human-readable note explaining that the parent's total cost is stable, suggesting code reorganization rather than a true regression.

### 4.4 The +/-2% Threshold

The roadmap chooses 2% as the cost shift threshold. This is conservative for tracemeld's scale. At Meta's scale with millions of samples, tighter thresholds are feasible. For LLM agent profiles with fewer samples and more inherent variance between runs, 2% is a reasonable starting point. The threshold should be configurable via the `diff_profile` tool's parameters in a future iteration.

---

## 5. Statistical Significance and Detection Algorithms

### 5.1 FBDetect's Detection Pipeline

FBDetect defines a regression as a **shift in the mean** of a time series. It uses two algorithms:

- **Short-term detection**: For sudden step-function changes (e.g., a code deploy causes immediate regression). Uses CUSUM (Cumulative Sum) with Expectation Maximization to identify change points. More sensitive to abrupt shifts but carefully designed to filter transient noise.

- **Long-term detection**: For gradual incremental changes that accumulate over weeks. Insensitive to sudden spikes, focuses on sustained drift.

### 5.2 Change Point Detection (CUSUM + EM)

The Change Point Detector iteratively applies CUSUM and EM:

1. Estimate means before (mu0) and after (mu1) a candidate change point.
2. Compute the CUSUM statistic to find the point maximizing the likelihood of different means.
3. Iterate until convergence at the maximum-likelihood change point.
4. Conduct a **log-likelihood ratio test**: null hypothesis H0 = no change point (single mean), alternative H1 = change point with two means.
5. Reject H0 if the log-likelihood ratio exceeds the chi-squared threshold.

### 5.3 False Positive Filters

Beyond cost shift detection, FBDetect applies:

- **Seasonality detector**: Applies autocorrelation to detect periodic patterns. If significant, runs STL (Seasonal-Trend decomposition using Loess) to separate seasonality, trend, and residual. Re-tests the regression on the deseasonalized signal using a pseudo z-score. Both the analysis window and an extended window must show z-scores below the threshold.

- **Went-away detector**: Checks if a detected regression subsequently reversed (inverse CUSUM analysis). If the inverse regression's magnitude sufficiently compensates, the original is filtered as transient.

- **Root cause attribution**: For confirmed regressions, compares gCPU before/after at the stack-trace level to attribute the regression magnitude to specific code changes.

### 5.4 False Positive Rate

Manual analysis of 107 positive cases: 76 true positives, 31 false positives. But against 35,000 negative cases, the overall false positive rate is 31/(35,000+31) = **0.088%**.

### 5.5 What tracemeld Uses

Tracemeld does **not** operate on continuous time series, so CUSUM, seasonality detection, and went-away detection are not applicable. Tracemeld compares two discrete baseline digests.

Relevant statistical concepts for tracemeld:

| FBDetect concept | tracemeld equivalent |
|---|---|
| Change point detection | Not needed -- comparison is between two known points (before/after baselines) |
| z-score threshold | `min_delta_pct` parameter (default 5%) serves as the significance filter |
| Cost shift filter | Implemented directly via parent-stack total_cost comparison |
| Seasonality removal | Not applicable -- single-session profiles have no periodicity |
| Root cause attribution | `diff_profile`'s ranked regression list serves this purpose |

The `min_delta_pct` threshold (default 5%) is tracemeld's practical equivalent of a significance threshold. Given the inherent variance in LLM agent sessions (non-deterministic model responses, variable network latency, different code paths taken), changes below 5% are unlikely to be meaningful signal.

---

## 6. Adapting FBDetect to tracemeld's Scale

### 6.1 Scale Comparison

FBDetect operates at hyperscale: millions of servers, 800,000 monitored time series, regressions caught at 0.005%. Tracemeld operates at agent scale: single sessions, dozens of frames, meaningful threshold around 5%.

The adaptation is not about replicating FBDetect's detection pipeline. It is about borrowing three specific ideas:

1. **gCPU as the comparison unit** -- normalized per-frame cost fractions rather than raw durations. This is directly implemented via `total_cost[dim] / sum(all_total_costs)` on `frame_costs[]`.

2. **Variance reduction through granularity** -- comparing at the frame level rather than the session level provides more actionable signal. A 5s increase in total session time is ambiguous; a 300% increase in `llm_call:gpt-4` gCPU is diagnostic.

3. **Cost shift detection** -- the parent-stack comparison filter prevents flagging code reorganization as regression. This is implemented as described in Section 4.3.

### 6.2 What tracemeld Adds Beyond FBDetect

FBDetect operates on a single dimension (CPU). Tracemeld profiles are **multi-dimensional** (wall time, token count, LLM cost, API calls, etc.). The diff engine computes deltas across all dimensions simultaneously, which can reveal cases where:

- Wall time improved but token count regressed (faster but more expensive)
- API call count dropped but latency per call increased (batching tradeoff)
- A regression in one dimension is offset by improvement in another

This multi-dimensional view is unique to tracemeld and is not addressed by FBDetect.

---

## 7. Additional References Discovered During Distillation

### Meta's Kats Library (CUSUM Implementation)

- **Repository**: https://github.com/facebookresearch/Kats
- **CUSUM detector source**: https://github.com/facebookresearch/Kats/blob/main/kats/detectors/cusum_detection.py
- **API documentation**: https://facebookresearch.github.io/Kats/api/kats.detectors.cusum_detection.html
- **Detection tutorial**: https://github.com/facebookresearch/Kats/blob/main/tutorials/kats_202_detection.ipynb

Kats is Meta's open-source time series analysis toolkit. Its `CUSUMDetector` is a reference implementation of the change point detection algorithm used by FBDetect. Returns: direction, change point index, delta, mu0 (mean before), mu1 (mean after), log-likelihood ratio, p-value, and regression_detected flag. Not directly needed by tracemeld (which compares discrete baselines, not time series), but useful as a reference if tracemeld later adds continuous monitoring.

### Extended FBDetect (ACM TOCS 2025)

- **DOI**: https://dl.acm.org/doi/10.1145/3785504
- Title: "Detecting Tiny Performance Regressions at Hyperscale"
- Extends the SOSP 2024 paper with ServiceLab integration. Invited for extended publication by the SOSP 2024 chairs.

### Related Meta Work

- **Learning to Learn to Predict Performance Regressions in Production at Meta**: https://arxiv.org/pdf/2208.04351 -- Earlier ML-based approach to regression prediction, predecessor context for FBDetect.

### Brendan Gregg's Differential Flamegraphs

FBDetect's gCPU concept is complementary to Gregg's differential flamegraph technique. Gregg's `difffolded.pl` provides the structural diff algorithm (full outer join, normalization); FBDetect provides the statistical interpretation layer (is this diff signal or noise?). Tracemeld's `diff_profile` combines both: Gregg's algorithm for computing the diff, FBDetect's cost shift filter for qualifying results.

- See companion reference: `refs/gregg-differential-flamegraphs.md`
- See companion reference: `refs/bezemer-flamegraphdiff.md`

---

## 8. Summary: What tracemeld Borrows from FBDetect

| FBDetect Concept | tracemeld Application | Implementation Location |
|---|---|---|
| gCPU metric | `total_cost[dim] / sum(all_total_costs)` on `frame_costs[]` | `src/analysis/diff.ts` |
| Variance reduction principle | Compare at frame level, not session level | Architectural decision in diff output design |
| Cost shift filter (34% false positive reduction) | Parent-stack total_cost comparison, +/-2% threshold | `src/analysis/diff.ts`, step 6 of diff algorithm |
| `min_delta_pct` as significance proxy | Default 5% threshold, configurable | `diff_profile` tool parameter |
| Multi-dimensional extension | Per-dimension gCPU and delta computation | `DiffResult.headline` and `DiffEntry.delta` records |
