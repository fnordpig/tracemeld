// src/analysis/bottleneck.ts
import type { Profile } from '../model/types.js';
import { getAllSpans, getSpanAncestry, computeSelfCost, valuesToRecord, extractKind } from './query.js';

export interface BottleneckInput {
  dimension: string;
  top_n?: number;
}

export interface BottleneckEntry {
  span_id: string;
  name: string;
  kind: string;
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
  let totalCost = 0;
  for (const span of allSpans) {
    totalCost += (computeSelfCost(profile, span)[dimIndex] ?? 0);
  }
  if (totalCost === 0) return { dimension: dim, entries: [] };

  const entries: BottleneckEntry[] = [];
  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span);
    const selfVal = selfCost[dimIndex] ?? 0;
    if (selfVal <= 0) continue;

    const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
    const pctOfTotal = (selfVal / totalCost) * 100;
    const impactScore = selfVal * (selfVal / totalCost);

    entries.push({
      span_id: span.id,
      name: frameName,
      kind: extractKind(frameName),
      ancestry: getSpanAncestry(profile, span),
      self_cost: valuesToRecord(profile, selfCost),
      total_cost: valuesToRecord(profile, span.values),
      impact_score: Math.round(impactScore * 100) / 100,
      pct_of_total: Math.round(pctOfTotal * 100) / 100,
      recommendation: generateRecommendation(frameName, pctOfTotal),
    });
  }

  entries.sort((a, b) => b.impact_score - a.impact_score);
  return { dimension: dim, entries: entries.slice(0, topN) };
}

function generateRecommendation(frameName: string, pctOfTotal: number): string {
  const kind = extractKind(frameName);
  const pctStr = `${Math.round(pctOfTotal)}%`;
  switch (kind) {
    case 'bash': return `This command accounts for ${pctStr} of total cost. Consider scoping it more tightly or caching results.`;
    case 'file_read': return `This file read accounts for ${pctStr} of total cost. Consider reading only the relevant section.`;
    case 'file_write': return `This file write accounts for ${pctStr} of total cost. Consider batching changes.`;
    case 'thinking': return `Thinking accounts for ${pctStr} of total cost. Consider breaking the problem into smaller steps.`;
    case 'validation': return `Validation accounts for ${pctStr} of total cost. Consider scoping tests to affected files.`;
    default: return `This operation accounts for ${pctStr} of total cost. Consider whether it can be optimized or eliminated.`;
  }
}
