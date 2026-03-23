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
  /**
   * Map dimension keys across baselines: { from_key: to_key }.
   * e.g. { weight: 'wall_ms' } treats 'weight' as 'wall_ms' for comparison.
   * When 'auto', infers a mapping if each side has exactly one non-zero
   * dimension and they don't overlap. Default: 'auto'.
   */
  dimension_map?: Record<string, string> | 'auto';
}

/**
 * Resolve dimension mapping between two baselines.
 * - Explicit map: use as-is
 * - 'auto' (default): if each side has exactly one non-zero dimension and they
 *   don't overlap, map the before's dimension to the after's.
 * Returns a Map<from_key, to_key> that can remap either side's keys.
 */
function resolveDimensionMap(
  before: BaselineDigest,
  after: BaselineDigest,
  mapping?: Record<string, string> | 'auto',
): Map<string, string> {
  if (mapping !== undefined && mapping !== 'auto') {
    return new Map(Object.entries(mapping));
  }

  // Auto-detect: find non-zero dimensions on each side
  const beforeNonZero = before.value_types
    .map((vt) => vt.key)
    .filter((k) => (before.totals[k] ?? 0) > 0);
  const afterNonZero = after.value_types
    .map((vt) => vt.key)
    .filter((k) => (after.totals[k] ?? 0) > 0);

  // Only auto-map when each side has exactly one non-zero dimension and they differ
  if (
    beforeNonZero.length === 1 &&
    afterNonZero.length === 1 &&
    beforeNonZero[0] !== afterNonZero[0]
  ) {
    return new Map([[beforeNonZero[0], afterNonZero[0]]]);
  }

  return new Map();
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
  // Phase 0: Resolve dimension mapping
  const dimMap = resolveDimensionMap(before, after, options?.dimension_map);

  // Apply mapping: remap before's dimension keys so they align with after's
  // dimMap maps from_key → to_key (e.g. { weight: 'wall_ms' })
  // We build remapped value_types and totals for before
  const remappedBeforeVT = before.value_types.map((vt) => ({
    ...vt,
    key: dimMap.get(vt.key) ?? vt.key,
  }));
  const remappedBeforeTotals: Record<string, number> = {};
  for (const [k, v] of Object.entries(before.totals)) {
    remappedBeforeTotals[dimMap.get(k) ?? k] = v;
  }
  // Also remap after's keys (mapping can go either direction)
  const remappedAfterVT = after.value_types.map((vt) => ({
    ...vt,
    key: dimMap.get(vt.key) ?? vt.key,
  }));
  const remappedAfterTotals: Record<string, number> = {};
  for (const [k, v] of Object.entries(after.totals)) {
    remappedAfterTotals[dimMap.get(k) ?? k] = v;
  }

  // Build unified dimension set from both baselines, preserving order (after first, then any before-only)
  const afterDims = remappedAfterVT.map((vt) => vt.key);
  const beforeDims = remappedBeforeVT.map((vt) => vt.key);
  const dimSet = new Set(afterDims);
  for (const d of beforeDims) dimSet.add(d);
  const dims = [...dimSet];

  // Build positional index maps: remapped dimension key → index in each baseline's self_cost/total_cost arrays
  // The arrays are still positionally indexed by the original value_types order
  const beforeDimIdx = new Map<string, number>();
  for (let i = 0; i < remappedBeforeVT.length; i++) beforeDimIdx.set(remappedBeforeVT[i].key, i);
  const afterDimIdx = new Map<string, number>();
  for (let i = 0; i < remappedAfterVT.length; i++) afterDimIdx.set(remappedAfterVT[i].key, i);

  const firstDim = dims.length > 0 ? dims[0] : 'wall_ms';
  const primaryDim = options?.dimension ?? firstDim;
  const minDeltaPct = options?.min_delta_pct ?? 5;
  const normalize = options?.normalize ?? true;
  const topN = options?.top_n ?? 15;

  // Phase 1: Compute per-dimension totals for normalization
  const beforeTotals: Record<string, number> = { ...remappedBeforeTotals };
  const afterTotals: Record<string, number> = { ...remappedAfterTotals };

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

  for (const stack of allStacks) {
    const bfc = beforeMap.get(stack);
    const afc = afterMap.get(stack);

    const leafName = stack.includes(';') ? stack.slice(stack.lastIndexOf(';') + 1) : stack;

    const beforeCosts: Record<string, number> = {};
    const afterCosts: Record<string, number> = {};
    const delta: Record<string, number> = {};
    const deltaPct: Record<string, number> = {};

    for (const dim of dims) {
      const bi = beforeDimIdx.get(dim);
      const ai = afterDimIdx.get(dim);
      const bv = bfc && bi !== undefined ? (bfc.self_cost[bi] ?? 0) * (normalize ? normFactors[dim] : 1) : 0;
      const av = afc && ai !== undefined ? (afc.self_cost[ai] ?? 0) : 0;

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
      const bpi = beforeDimIdx.get(primaryDim);
      const api = afterDimIdx.get(primaryDim);
      const parentBefore = bpi !== undefined ? (parentBfc.total_cost[bpi] ?? 0) * (normalize ? (normFactors[primaryDim] ?? 1) : 1) : 0;
      const parentAfter = api !== undefined ? (parentAfc.total_cost[api] ?? 0) : 0;
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

  // Phase 6: Headline comparison — always use raw totals (not normalized)
  // so users see actual cost changes, not distribution-adjusted values
  const headline: DiffResult['headline'] = {};
  for (const dim of dims) {
    const bv = beforeTotals[dim] ?? 0;
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
