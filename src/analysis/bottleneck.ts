// src/analysis/bottleneck.ts
import type { Profile } from '../model/types.js';
import {
  getAllSpans, buildSpanIndex, getSpanAncestry, computeSelfCost, valuesToRecord, extractKind,
  getSpanSourceLocation, getSourceLocation, aggregateSamplesByFrame, type SourceLocation,
} from './query.js';

export interface BottleneckInput {
  dimension: string;
  top_n?: number;
}

export interface BottleneckEntry {
  span_id: string;
  name: string;
  kind: string;
  code_location?: SourceLocation;
  ancestry: string[];
  self_cost: Record<string, number>;
  total_cost: Record<string, number>;
  impact_score: number;
  pct_of_total: number;
  recommendation: string;
}

export interface BottleneckResult {
  dimension: string;
  entries: BottleneckEntry[];
}

export function findBottlenecks(profile: Profile, input: BottleneckInput): BottleneckResult {
  const topN = input.top_n ?? 10;
  const dim = input.dimension;
  const dimIndex = profile.value_types.findIndex((vt) => vt.key === dim);
  if (dimIndex < 0) return { dimension: dim, entries: [] };

  const allSpans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);

  // Compute self-cost once per span, cache for reuse
  const selfCostCache = new Map<string, number[]>();
  let totalCost = 0;
  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span, spanIndex);
    selfCostCache.set(span.id, selfCost);
    totalCost += (selfCost[dimIndex] ?? 0);
  }

  // Include sample self-cost in totalCost
  const frameStats = aggregateSamplesByFrame(profile);
  for (const fs of frameStats) {
    totalCost += fs.self_cost[dimIndex] ?? 0;
  }

  if (totalCost === 0) return { dimension: dim, entries: [] };

  const entries: BottleneckEntry[] = [];
  for (const span of allSpans) {
    const selfCost = selfCostCache.get(span.id) ?? computeSelfCost(profile, span, spanIndex);
    const selfVal = selfCost[dimIndex] ?? 0;
    if (selfVal <= 0) continue;

    const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
    const pctOfTotal = (selfVal / totalCost) * 100;
    const impactScore = selfVal * (selfVal / totalCost);

    const source = getSpanSourceLocation(profile, span);
    entries.push({
      span_id: span.id,
      name: frameName,
      kind: extractKind(frameName),
      code_location: source,
      ancestry: getSpanAncestry(profile, span, spanIndex),
      self_cost: valuesToRecord(profile, selfCost),
      total_cost: valuesToRecord(profile, span.values),
      impact_score: Math.round(impactScore * 100) / 100,
      pct_of_total: Math.round(pctOfTotal * 100) / 100,
      recommendation: generateRecommendation(frameName, pctOfTotal, source?.ref),
    });
  }

  // Add sample-based entries
  const spanEntryNames = new Set(entries.map(e => e.name));
  for (const fs of frameStats) {
    const selfVal = fs.self_cost[dimIndex] ?? 0;
    if (selfVal <= 0) continue;

    // Don't duplicate if this frame was already counted from spans
    if (spanEntryNames.has(fs.name)) continue;

    const pctOfTotal = (selfVal / totalCost) * 100;
    const impactScore = selfVal * (selfVal / totalCost);

    const source = getSourceLocation(profile, fs.frame_index);
    entries.push({
      span_id: `frame:${fs.frame_index}`,
      name: fs.name,
      kind: extractKind(fs.name),
      code_location: source,
      ancestry: [fs.name],
      self_cost: valuesToRecord(profile, fs.self_cost),
      total_cost: valuesToRecord(profile, fs.total_cost),
      impact_score: Math.round(impactScore * 100) / 100,
      pct_of_total: Math.round(pctOfTotal * 100) / 100,
      recommendation: generateRecommendation(fs.name, pctOfTotal, source?.ref),
    });
  }

  entries.sort((a, b) => b.impact_score - a.impact_score);
  return { dimension: dim, entries: entries.slice(0, topN) };
}

function generateRecommendation(frameName: string, pctOfTotal: number, sourceRef?: string): string {
  const kind = extractKind(frameName);
  const pctStr = `${Math.round(pctOfTotal)}%`;
  const readHint = sourceRef ? ` Read ${sourceRef} to understand the implementation.` : '';
  switch (kind) {
    case 'bash': return `This command accounts for ${pctStr} of total cost. Consider scoping it more tightly or caching results.${readHint}`;
    case 'file_read': return `This file read accounts for ${pctStr} of total cost. Consider reading only the relevant section.${readHint}`;
    case 'file_write': return `This file write accounts for ${pctStr} of total cost. Consider batching changes.${readHint}`;
    case 'thinking': return `Thinking accounts for ${pctStr} of total cost. Consider breaking the problem into smaller steps.`;
    case 'validation': return `Validation accounts for ${pctStr} of total cost. Consider scoping tests to affected files.${readHint}`;
    default: return `This operation accounts for ${pctStr} of total cost.${readHint || ' Consider whether it can be optimized or eliminated.'}`;
  }
}
