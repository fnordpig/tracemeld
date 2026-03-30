// src/exporters/baseline.ts
import type { Frame, Profile } from '../model/types.js';
import type {
  BaselineDigest,
  KindBreakdown,
  FrameCost,
  DimensionHotspots,
  HotspotEntry,
  PatternEntry,
  BaselineStats,
} from './baseline-types.js';
import type { PatternRegistry } from '../patterns/registry.js';
import {
  getAllSpans,
  buildSpanIndex,
  getSpanAncestry,
  computeSelfCost,
  extractKind,
  valuesToRecord,
} from '../analysis/query.js';
import { findHotspots } from '../analysis/hotspots.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as { version: string };

export function exportBaseline(
  profile: Profile,
  tags: BaselineDigest['tags'],
  patterns?: PatternRegistry,
): BaselineDigest {
  const spans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);
  const vtLen = profile.value_types.length;

  // 1. Compute headline totals using self-cost (avoids double-counting)
  // Cache self-cost per span — reused in kind breakdown and frame costs.
  const selfCostCache = new Map<string, number[]>();
  const totalValues = new Array<number>(vtLen).fill(0);
  let errorCount = 0;

  for (const span of spans) {
    const selfCost = computeSelfCost(profile, span, spanIndex);
    selfCostCache.set(span.id, selfCost);
    for (let i = 0; i < vtLen; i++) {
      totalValues[i] += selfCost[i] ?? 0;
    }
    if (span.error) errorCount++;
  }

  // Include samples in totals
  let sampleCount = 0;
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      sampleCount++;
      for (let i = 0; i < vtLen; i++) {
        totalValues[i] += sample.values[i] ?? 0;
      }
    }
  }

  const totals = valuesToRecord(profile, totalValues);

  // 2. Kind breakdown — group spans by frame kind
  const kindMap = new Map<string, { values: number[]; spanCount: number; errorCount: number }>();

  for (const span of spans) {
    const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '<unknown>';
    const kind = extractKind(frameName);
    let entry = kindMap.get(kind);
    if (!entry) {
      entry = { values: new Array<number>(vtLen).fill(0), spanCount: 0, errorCount: 0 };
      kindMap.set(kind, entry);
    }
    const selfCost = selfCostCache.get(span.id) ?? computeSelfCost(profile, span, spanIndex);
    for (let i = 0; i < vtLen; i++) {
      entry.values[i] += selfCost[i] ?? 0;
    }
    entry.spanCount++;
    if (span.error) entry.errorCount++;
  }

  const kind_breakdown: KindBreakdown[] = [];
  for (const [kind, entry] of kindMap) {
    kind_breakdown.push({
      kind,
      totals: valuesToRecord(profile, entry.values),
      span_count: entry.spanCount,
      error_count: entry.errorCount,
    });
  }
  // Sort by first dimension descending
  const firstDimKey = profile.value_types[0]?.key;
  kind_breakdown.sort((a, b) => {
    const av = firstDimKey ? (a.totals[firstDimKey] ?? 0) : 0;
    const bv = firstDimKey ? (b.totals[firstDimKey] ?? 0) : 0;
    return bv - av;
  });

  // 3. Frame costs — aggregate by stack path (collapsed-stack style)
  const costMap = new Map<string, { selfCost: number[]; totalCost: number[]; callCount: number }>();

  for (const span of spans) {
    const ancestry = getSpanAncestry(profile, span, spanIndex);
    const stackKey = ancestry.join(';');
    let entry = costMap.get(stackKey);
    if (!entry) {
      entry = {
        selfCost: new Array<number>(vtLen).fill(0),
        totalCost: new Array<number>(vtLen).fill(0),
        callCount: 0,
      };
      costMap.set(stackKey, entry);
    }
    const selfCost = selfCostCache.get(span.id) ?? computeSelfCost(profile, span, spanIndex);
    for (let i = 0; i < vtLen; i++) {
      entry.selfCost[i] += selfCost[i] ?? 0;
      entry.totalCost[i] += span.values[i] ?? 0;
    }
    entry.callCount++;
  }

  const frame_costs: FrameCost[] = [];
  for (const [stack, entry] of costMap) {
    frame_costs.push({
      stack,
      self_cost: entry.selfCost,
      total_cost: entry.totalCost,
      call_count: entry.callCount,
    });
  }
  // Sort by first dimension total_cost descending
  frame_costs.sort((a, b) => (b.total_cost[0] ?? 0) - (a.total_cost[0] ?? 0));

  // 4. Hotspots — top 10 per dimension
  const hotspots: DimensionHotspots[] = [];
  for (const vt of profile.value_types) {
    const result = findHotspots(profile, { dimension: vt.key, top_n: 10 }, patterns);
    const entries: HotspotEntry[] = result.entries.map((e) => ({
      name: e.name,
      self_cost: e.self_cost[vt.key] ?? 0,
      pct_of_total: e.pct_of_total,
    }));
    hotspots.push({ dimension: vt.key, entries });
  }

  // 5. Patterns
  const patternEntries: PatternEntry[] = [];
  if (patterns) {
    const matches = patterns.detect(profile);
    // Group by pattern name
    const patternMap = new Map<string, { severity: string; description: string; count: number }>();
    for (const match of matches) {
      const existing = patternMap.get(match.pattern.name);
      if (existing) {
        existing.count++;
      } else {
        patternMap.set(match.pattern.name, {
          severity: match.pattern.severity,
          description: match.pattern.description,
          count: 1,
        });
      }
    }
    for (const [name, entry] of patternMap) {
      patternEntries.push({
        name,
        severity: entry.severity,
        description: entry.description,
        count: entry.count,
      });
    }
  }

  // 6. Stats
  let minStart = Infinity;
  let maxEnd = 0;
  for (const span of spans) {
    if (span.start_time < minStart) minStart = span.start_time;
    if (span.end_time > maxEnd) maxEnd = span.end_time;
  }
  const wallDuration = spans.length > 0 ? maxEnd - minStart : 0;

  const stats: BaselineStats = {
    span_count: spans.length,
    sample_count: sampleCount,
    frame_count: profile.frames.length,
    lane_count: profile.lanes.length,
    error_count: errorCount,
    wall_duration_ms: wallDuration,
  };

  // 7. Source formats
  const sourceFormats: string[] = [];
  const metaFormats = profile.metadata['source_formats'];
  if (Array.isArray(metaFormats)) {
    for (const f of metaFormats) {
      if (typeof f === 'string') sourceFormats.push(f);
    }
  } else {
    const importedFrom = profile.metadata['imported_from'];
    if (typeof importedFrom === 'string') sourceFormats.push(importedFrom);
  }

  return {
    version: 1,
    exporter: `tracemeld@${pkg.version}`,
    created_at: Date.now(),
    tags,
    value_types: profile.value_types,
    source_formats: sourceFormats,
    totals,
    kind_breakdown,
    frame_costs,
    hotspots,
    patterns: patternEntries,
    stats,
  };
}
