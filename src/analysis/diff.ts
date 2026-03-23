// src/analysis/diff.ts — Differential profile comparison
//
// Algorithm based on Brendan Gregg's difffolded.pl:
//   https://github.com/brendangregg/FlameGraph/blob/master/difffolded.pl
// Percentage formula per flamegraph.pl / GitHub Issue #170:
//   delta_pct = (after - before) / after * 100 (flamegraph.pl convention)
// Cost shift detection inspired by FBDetect (SOSP 2024):
//   https://tangchq74.github.io/FBDetect-SOSP24.pdf

import type { BaselineDigest, DiffResult, DiffEntry, FrameCost } from '../exporters/baseline-types.js';

export interface DiffOptions {
  /** Primary dimension key to rank by. Default: first value_type key. */
  dimension?: string;
  /** Minimum absolute percentage change to report. Default: 5. */
  min_delta_pct?: number;
  /** Normalize before/after totals. Default: true. */
  normalize?: boolean;
  /** Max regressions/improvements to return. Default: 15. */
  top_n?: number;
}

/**
 * Compare two baseline digests: `before` (stored baseline) vs `after` (current).
 * Returns structured diff with regressions, improvements, new/removed stacks,
 * headline comparison, and pattern diff.
 */
export function diffBaselines(
  before: BaselineDigest,
  after: BaselineDigest,
  options?: DiffOptions,
): DiffResult {
  const dims = after.value_types.map((vt) => vt.key);
  const firstDim = dims.length > 0 ? dims[0] : 'wall_ms';
  const primaryDim = options?.dimension ?? firstDim;
  const primaryIdx = dims.indexOf(primaryDim);
  const minDeltaPct = options?.min_delta_pct ?? 5;
  const normalize = options?.normalize ?? true;
  const topN = options?.top_n ?? 15;

  // Phase 1: Compute per-dimension totals for normalization
  const beforeTotals: Record<string, number> = { ...before.totals };
  const afterTotals: Record<string, number> = { ...after.totals };

  // Compute normalization factors per dimension
  const normFactors: Record<string, number> = {};
  for (const dim of dims) {
    const bt = beforeTotals[dim] ?? 0;
    const at = afterTotals[dim] ?? 0;
    normFactors[dim] = bt > 0 && at > 0 && normalize ? at / bt : 1;
  }

  // Phase 2: Full outer join on frame_costs by stack key
  const beforeMap = new Map<string, FrameCost>();
  for (const fc of before.frame_costs) {
    beforeMap.set(fc.stack, fc);
  }
  const afterMap = new Map<string, FrameCost>();
  for (const fc of after.frame_costs) {
    afterMap.set(fc.stack, fc);
  }

  const allStacks = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  // Phase 3: Compute deltas
  const regressions: DiffEntry[] = [];
  const improvements: DiffEntry[] = [];
  const newStacks: DiffEntry[] = [];
  const removedStacks: DiffEntry[] = [];

  // Build parent stack map for cost shift detection
  const parentSelfDelta = new Map<string, Record<string, number>>();

  for (const stack of allStacks) {
    const bfc = beforeMap.get(stack);
    const afc = afterMap.get(stack);

    const leafName = stack.includes(';') ? stack.slice(stack.lastIndexOf(';') + 1) : stack;

    const beforeCosts: Record<string, number> = {};
    const afterCosts: Record<string, number> = {};
    const delta: Record<string, number> = {};
    const deltaPct: Record<string, number> = {};

    for (let i = 0; i < dims.length; i++) {
      const dim = dims[i];
      const bv = bfc ? (bfc.self_cost[i] ?? 0) * (normalize ? normFactors[dim] : 1) : 0;
      const av = afc ? (afc.self_cost[i] ?? 0) : 0;

      beforeCosts[dim] = bv;
      afterCosts[dim] = av;
      delta[dim] = av - bv;

      // flamegraph.pl convention: (new - old) / new * 100
      if (av !== 0) {
        deltaPct[dim] = ((av - bv) / av) * 100;
      } else if (bv !== 0) {
        deltaPct[dim] = -100; // stack vanished
      } else {
        deltaPct[dim] = 0;
      }
    }

    const entry: DiffEntry = { stack, name: leafName, before: beforeCosts, after: afterCosts, delta, delta_pct: deltaPct };

    // Store for cost shift detection
    parentSelfDelta.set(stack, delta);

    if (!bfc) {
      newStacks.push(entry);
    } else if (!afc) {
      removedStacks.push(entry);
    } else {
      const primaryDelta = delta[primaryDim] ?? 0;
      if (primaryDelta > 0) {
        regressions.push(entry);
      } else if (primaryDelta < 0) {
        improvements.push(entry);
      }
    }
  }

  // Phase 4: Cost shift detection (FBDetect-inspired)
  // If a child regressed but its parent's total cost is stable, flag as likely_refactoring
  for (const entry of regressions) {
    if (!entry.stack.includes(';')) continue;
    const parentStack = entry.stack.slice(0, entry.stack.lastIndexOf(';'));
    const parentBfc = beforeMap.get(parentStack);
    const parentAfc = afterMap.get(parentStack);
    if (parentBfc && parentAfc) {
      const pidx = primaryIdx >= 0 ? primaryIdx : 0;
      const parentBefore = (parentBfc.total_cost[pidx] ?? 0) * (normalize ? (normFactors[primaryDim] ?? 1) : 1);
      const parentAfter = parentAfc.total_cost[pidx] ?? 0;
      const parentDeltaPct = parentAfter !== 0 ? Math.abs((parentAfter - parentBefore) / parentAfter) * 100 : 0;
      if (parentDeltaPct < 2) {
        entry.likely_refactoring = true;
      }
    }
  }

  // Phase 5: Filter and rank
  const filteredRegressions = regressions
    .filter((e) => Math.abs(e.delta_pct[primaryDim] ?? 0) >= minDeltaPct)
    .sort((a, b) => (b.delta[primaryDim] ?? 0) - (a.delta[primaryDim] ?? 0))
    .slice(0, topN);

  const filteredImprovements = improvements
    .filter((e) => Math.abs(e.delta_pct[primaryDim] ?? 0) >= minDeltaPct)
    .sort((a, b) => (a.delta[primaryDim] ?? 0) - (b.delta[primaryDim] ?? 0))
    .slice(0, topN);

  const sortedNewStacks = newStacks
    .sort((a, b) => (b.after[primaryDim] ?? 0) - (a.after[primaryDim] ?? 0))
    .slice(0, topN);

  const sortedRemovedStacks = removedStacks
    .sort((a, b) => (b.before[primaryDim] ?? 0) - (a.before[primaryDim] ?? 0))
    .slice(0, topN);

  // Phase 6: Headline comparison
  const headline: DiffResult['headline'] = {};
  for (const dim of dims) {
    const bv = (beforeTotals[dim] ?? 0) * (normalize ? normFactors[dim] : 1);
    const av = afterTotals[dim] ?? 0;
    headline[dim] = {
      before: bv,
      after: av,
      delta: av - bv,
      delta_pct: av !== 0 ? ((av - bv) / av) * 100 : bv !== 0 ? -100 : 0,
    };
  }

  // Phase 7: Regression warnings
  const regressionWarnings: DiffResult['regression_warnings'] = [];
  for (const dim of dims) {
    const h = headline[dim];
    if (h.delta > 0) {
      regressionWarnings.push({
        dimension: dim,
        delta_pct: h.delta_pct,
        note: `Total ${dim} increased by ${h.delta_pct.toFixed(1)}%`,
      });
    }
  }

  // Phase 8: Pattern diff
  const beforePatterns = new Set(before.patterns.map((p) => p.name));
  const afterPatterns = new Set(after.patterns.map((p) => p.name));
  const newPatterns = [...afterPatterns].filter((p) => !beforePatterns.has(p));
  const resolvedPatterns = [...beforePatterns].filter((p) => !afterPatterns.has(p));

  // Derive baseline_name from tags
  const baselineName = typeof before.tags.task === 'string' ? before.tags.task : before.tags.checkpoint;

  return {
    baseline_name: baselineName,
    baseline_created_at: before.created_at,
    normalized: normalize && Object.values(normFactors).some((f) => f !== 1),
    norm_factor: normalize ? normFactors[primaryDim] : undefined,
    headline,
    regressions: filteredRegressions,
    improvements: filteredImprovements,
    new_stacks: sortedNewStacks,
    removed_stacks: sortedRemovedStacks,
    regression_warnings: regressionWarnings,
    pattern_diff: { new_patterns: newPatterns, resolved_patterns: resolvedPatterns },
  };
}
