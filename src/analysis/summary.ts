// src/analysis/summary.ts
import type { Frame, Profile, Span } from '../model/types.js';
import {
  getAllSpans,
  getSpanById,
  extractKind,
  filterSpansByTimeRange,
  valuesToRecord,
  computeSelfCost,
  type TimeRange,
} from './query.js';

export interface ProfileSummaryInput {
  group_by?: 'kind' | 'turn' | 'lane';
  time_range?: TimeRange;
}

export interface ProfileGroupResult {
  key: string;
  totals: Record<string, number>;
  pct_of_total: Record<string, number>;
  span_count: number;
  error_count: number;
  investigate?: {
    dimension: string;
    pct: number;
    hint: string;
  };
}

export interface ProfileSummaryResult {
  totals: Record<string, number>;
  groups: ProfileGroupResult[];
  span_count: number;
  error_count: number;
  wall_duration_ms: number;
  active_duration_ms: number;
}

export function profileSummary(
  profile: Profile,
  input: ProfileSummaryInput,
): ProfileSummaryResult {
  const groupBy = input.group_by ?? 'kind';
  const allSpans = getAllSpans(profile);
  const spans = filterSpansByTimeRange(allSpans, input.time_range);

  // Compute totals using self-cost to avoid double-counting parent+child values.
  const totalValues = new Array<number>(profile.value_types.length).fill(0);
  let errorCount = 0;

  for (const span of spans) {
    const selfCost = computeSelfCost(profile, span);
    for (let i = 0; i < totalValues.length; i++) {
      totalValues[i] += selfCost[i] ?? 0;
    }
    if (span.error) errorCount++;
  }

  const totals = valuesToRecord(profile, totalValues);

  // Group spans
  const groups = new Map<string, { values: number[]; spanCount: number; errorCount: number }>();

  for (const span of spans) {
    const key = getGroupKey(profile, span, groupBy);
    let group = groups.get(key);
    if (!group) {
      group = {
        values: new Array<number>(profile.value_types.length).fill(0),
        spanCount: 0,
        errorCount: 0,
      };
      groups.set(key, group);
    }
    const spanSelfCost = computeSelfCost(profile, span);
    for (let i = 0; i < group.values.length; i++) {
      group.values[i] += spanSelfCost[i] ?? 0;
    }
    group.spanCount++;
    if (span.error) group.errorCount++;
  }

  // Build group results with percentages and investigation flags
  const groupResults: ProfileGroupResult[] = [];
  for (const [key, group] of groups) {
    const groupTotals = valuesToRecord(profile, group.values);
    const pctOfTotal: Record<string, number> = {};

    let maxPct = 0;
    let maxDimension = '';

    for (let i = 0; i < profile.value_types.length; i++) {
      const vtKey = (profile.value_types[i] as { key: string }).key;
      const pct = totalValues[i] > 0 ? (group.values[i] ?? 0) / (totalValues[i]) * 100 : 0;
      pctOfTotal[vtKey] = Math.round(pct * 100) / 100;
      if (pct > maxPct) {
        maxPct = pct;
        maxDimension = vtKey;
      }
    }

    const result: ProfileGroupResult = {
      key,
      totals: groupTotals,
      pct_of_total: pctOfTotal,
      span_count: group.spanCount,
      error_count: group.errorCount,
    };

    if (maxPct > 40) {
      result.investigate = {
        dimension: maxDimension,
        pct: Math.round(maxPct * 100) / 100,
        hint: `${Math.round(maxPct)}% of ${maxDimension} — call hotspots with dimension='${maxDimension}'`,
      };
    }

    groupResults.push(result);
  }

  // Sort groups by highest total across any dimension (descending)
  groupResults.sort((a, b) => {
    const aMax = Math.max(...Object.values(a.totals));
    const bMax = Math.max(...Object.values(b.totals));
    return bMax - aMax;
  });

  // Compute wall duration and active duration
  let minStart = Infinity;
  let maxEnd = 0;
  let idleDuration = 0;

  for (const span of spans) {
    if (span.start_time < minStart) minStart = span.start_time;
    if (span.end_time > maxEnd) maxEnd = span.end_time;
    const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
    if (frameName.startsWith('user_input:')) {
      idleDuration += span.end_time - span.start_time;
    }
  }

  const wallDuration = spans.length > 0 ? maxEnd - minStart : 0;

  return {
    totals,
    groups: groupResults,
    span_count: spans.length,
    error_count: errorCount,
    wall_duration_ms: wallDuration,
    active_duration_ms: wallDuration - idleDuration,
  };
}

function getGroupKey(profile: Profile, span: Span, groupBy: string): string {
  const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '<unknown>';
  switch (groupBy) {
    case 'kind':
      return extractKind(frameName);
    case 'turn': {
      let current: Span | undefined = span;
      while (current) {
        const name = (profile.frames[current.frame_index] as Frame | undefined)?.name ?? '';
        if (name.startsWith('turn:')) return name;
        if (!current.parent_id) break;
        current = getSpanById(profile, current.parent_id);
      }
      return 'no-turn';
    }
    case 'lane': {
      for (const lane of profile.lanes) {
        if (lane.spans.some((s) => s.id === span.id)) return lane.name;
      }
      return 'unknown';
    }
    default:
      return extractKind(frameName);
  }
}
