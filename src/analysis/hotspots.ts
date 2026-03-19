// src/analysis/hotspots.ts
import type { Frame, Profile, Span, DetectedPattern } from '../model/types.js';
import type { PatternRegistry } from '../patterns/registry.js';
import {
  getAllSpans,
  buildSpanIndex,
  getSpanAncestry,
  computeSelfCost,
  valuesToRecord,
  getSpanSourceLocation,
  type SourceLocation,
} from './query.js';

export interface HotspotsInput {
  dimension: string;
  top_n?: number;
  min_value?: number;
}

export interface HotspotEntry {
  span_id: string;
  ancestry: string[];
  name: string;
  source?: SourceLocation;
  total_cost: Record<string, number>;
  self_cost: Record<string, number>;
  pct_of_total: number;
  patterns: DetectedPattern[];
  investigate: string;
}

export interface HotspotsResult {
  dimension: string;
  entries: HotspotEntry[];
}

export function findHotspots(
  profile: Profile,
  input: HotspotsInput,
  registry?: PatternRegistry,
): HotspotsResult {
  const topN = input.top_n ?? 10;
  const minValue = input.min_value ?? 0;
  const dim = input.dimension;
  const isErrors = dim === 'errors';
  const spans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);

  const dimIndex = isErrors ? -1 : profile.value_types.findIndex((vt) => vt.key === dim);

  const ranked: Array<{ span: Span; selfCost: number[]; rankValue: number }> = [];

  for (const span of spans) {
    const selfCost = computeSelfCost(profile, span, spanIndex);
    let rankValue: number;

    if (isErrors) {
      rankValue = countSubtreeErrors(span, spans);
    } else if (dimIndex >= 0) {
      rankValue = selfCost[dimIndex] ?? 0;
    } else {
      rankValue = 0;
    }

    if (rankValue >= minValue) {
      ranked.push({ span, selfCost, rankValue });
    }
  }

  ranked.sort((a, b) => b.rankValue - a.rankValue);

  let dimensionTotal = 0;
  if (isErrors) {
    for (const span of spans) {
      if (span.error) dimensionTotal++;
    }
  } else if (dimIndex >= 0) {
    for (const item of ranked) {
      dimensionTotal += item.selfCost[dimIndex] ?? 0;
    }
  }

  const entries: HotspotEntry[] = [];
  for (const item of ranked.slice(0, topN)) {
    const frameName =
      (profile.frames[item.span.frame_index] as Frame | undefined)?.name ?? '<unknown>';
    const pctOfTotal =
      dimensionTotal > 0
        ? Math.round((item.rankValue / dimensionTotal) * 10000) / 100
        : 0;

    const source = getSpanSourceLocation(profile, item.span);
    const investigateHint = source?.ref
      ? `Read ${source.ref} to understand this function, then call explain_span with span_id '${item.span.id}'`
      : `call explain_span with span_id '${item.span.id}' to see the breakdown`;

    entries.push({
      span_id: item.span.id,
      ancestry: getSpanAncestry(profile, item.span, spanIndex),
      name: frameName,
      source,
      total_cost: valuesToRecord(profile, item.span.values),
      self_cost: valuesToRecord(profile, item.selfCost),
      pct_of_total: pctOfTotal,
      patterns: registry
        ? registry.getMatchesForSpan(profile, item.span.id).map((m) => ({ ...m.pattern, span_ids: m.span_ids }))
        : [],
      investigate: investigateHint,
    });
  }

  return { dimension: dim, entries };
}

function countSubtreeErrors(span: Span, allSpans: Span[]): number {
  let count = span.error ? 1 : 0;
  for (const childId of span.children) {
    const child = allSpans.find((s) => s.id === childId);
    if (child) count += countSubtreeErrors(child, allSpans);
  }
  return count;
}
