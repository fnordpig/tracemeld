// src/analysis/waste.ts
import type { Profile } from '../model/types.js';
import type { PatternRegistry } from '../patterns/registry.js';
import type { TimeRange } from './query.js';
import { filterSpansByTimeRange, getAllSpans } from './query.js';

export interface FindWasteInput {
  time_range?: TimeRange;
}

export interface WasteItem {
  pattern: string;
  description: string;
  span_ids: string[];
  counterfactual_savings: Record<string, number>;
  recommendation: string;
  evidence: Record<string, unknown>;
}

export interface FindWasteResult {
  total_savings: Record<string, number>;
  items: WasteItem[];
}

export function findWaste(
  profile: Profile,
  registry: PatternRegistry,
  input: FindWasteInput,
): FindWasteResult {
  const allMatches = registry.detect(profile);

  let matches = allMatches;
  if (input.time_range) {
    const spansInRange = new Set(
      filterSpansByTimeRange(getAllSpans(profile), input.time_range).map((s) => s.id),
    );
    matches = allMatches.filter((m) =>
      m.span_ids.some((id) => spansInRange.has(id)),
    );
  }

  const items: WasteItem[] = matches.map((m) => ({
    pattern: m.pattern.name,
    description: m.pattern.description,
    span_ids: m.span_ids,
    counterfactual_savings: m.counterfactual_savings,
    recommendation: m.recommendation,
    evidence: m.pattern.evidence,
  }));

  items.sort((a, b) => {
    const aMax = Math.max(0, ...Object.values(a.counterfactual_savings));
    const bMax = Math.max(0, ...Object.values(b.counterfactual_savings));
    return bMax - aMax;
  });

  const totalSavings: Record<string, number> = {};
  for (const vt of profile.value_types) {
    totalSavings[vt.key] = 0;
  }
  for (const item of items) {
    for (const [key, val] of Object.entries(item.counterfactual_savings)) {
      totalSavings[key] = (totalSavings[key] ?? 0) + val;
    }
  }

  return { total_savings: totalSavings, items };
}
