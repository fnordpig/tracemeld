// src/analysis/hotpaths.ts
import type { Profile } from '../model/types.js';
import {
  getAllSpans, buildSpanIndex, getSpanAncestry, computeSelfCost, valuesToRecord,
  getSpanSourceLocation, getSourceLocation, type SourceLocation,
} from './query.js';

export interface HotpathsInput {
  dimension: string;
  top_n?: number;
}

export interface HotpathEntry {
  frames: string[];
  leaf_source?: SourceLocation;
  leaf_cost: number;
  path_cost: Record<string, number>;
  pct_of_total: number;
  leaf_span_id: string | null;
}

export interface HotpathsResult {
  dimension: string;
  paths: HotpathEntry[];
}

export function findHotpaths(profile: Profile, input: HotpathsInput): HotpathsResult {
  const topN = input.top_n ?? 10;
  const dim = input.dimension;
  const dimIndex = profile.value_types.findIndex((vt) => vt.key === dim);
  if (dimIndex < 0) return { dimension: dim, paths: [] };

  const entries: HotpathEntry[] = [];

  // From spans: leaf spans (no children) with their ancestry
  const allSpans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);
  for (const span of allSpans) {
    if (span.children.length > 0) continue;
    const selfCost = computeSelfCost(profile, span, spanIndex);
    const leafCost = selfCost[dimIndex] ?? 0;
    if (leafCost <= 0) continue;
    entries.push({
      frames: getSpanAncestry(profile, span, spanIndex),
      leaf_source: getSpanSourceLocation(profile, span),
      leaf_cost: leafCost,
      path_cost: valuesToRecord(profile, selfCost),
      pct_of_total: 0,
      leaf_span_id: span.id,
    });
  }

  // From samples: each sample is a root-to-leaf path
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      const cost = sample.values[dimIndex] ?? 0;
      if (cost <= 0) continue;
      const leafFrameIdx = sample.stack[sample.stack.length - 1];
      entries.push({
        frames: sample.stack.map((idx) => profile.frames[idx]?.name ?? '<unknown>'),
        leaf_source: sample.stack.length > 0 ? getSourceLocation(profile, leafFrameIdx) : undefined,
        leaf_cost: cost,
        path_cost: valuesToRecord(profile, sample.values),
        pct_of_total: 0,
        leaf_span_id: null,
      });
    }
  }

  // Compute pct_of_total
  const fullTotal = entries.reduce((sum, e) => sum + e.leaf_cost, 0);
  for (const entry of entries) {
    entry.pct_of_total = fullTotal > 0
      ? Math.round((entry.leaf_cost / fullTotal) * 10000) / 100
      : 0;
  }

  entries.sort((a, b) => b.leaf_cost - a.leaf_cost);
  return { dimension: dim, paths: entries.slice(0, topN) };
}
