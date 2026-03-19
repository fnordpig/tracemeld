// src/analysis/explain.ts
import type { Frame, Profile, Span, DetectedPattern } from '../model/types.js';
import type { PatternRegistry } from '../patterns/registry.js';
import {
  getSpanById,
  getSpanAncestry,
  extractKind,
  valuesToRecord,
} from './query.js';

export interface ExplainSpanInput {
  span_id: string;
}

export interface ExplainSpanResult {
  span: {
    name: string;
    kind: string;
    start_time: number;
    end_time: number;
    duration_ms: number;
    cost: Record<string, number>;
    error?: string;
    args: Record<string, unknown>;
  };
  ancestry: string[];
  children: Array<{
    span_id: string;
    name: string;
    cost: Record<string, number>;
    pct_of_parent: Record<string, number>;
    error?: string;
  }>;
  causal_chain: Array<{
    timestamp: number;
    event: string;
    kind: string;
    cost: Record<string, number>;
    outcome?: string;
  }>;
  patterns: DetectedPattern[];
  recommendations: string[];
}

export function explainSpan(
  profile: Profile,
  input: ExplainSpanInput,
  registry?: PatternRegistry,
): ExplainSpanResult {
  const span = getSpanById(profile, input.span_id);

  if (!span) {
    return notFoundResult();
  }

  const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '<unknown>';
  const kind = extractKind(frameName);
  const ancestry = getSpanAncestry(profile, span);
  const cost = valuesToRecord(profile, span.values);

  const children = buildChildren(profile, span);
  const causalChain = buildCausalChain(profile, span);

  return {
    span: {
      name: frameName,
      kind,
      start_time: span.start_time,
      end_time: span.end_time,
      duration_ms: span.end_time - span.start_time,
      cost,
      error: span.error,
      args: span.args,
    },
    ancestry,
    children,
    causal_chain: causalChain,
    patterns: registry
      ? registry.getMatchesForSpan(profile, span.id).map((m) => ({ ...m.pattern, span_ids: m.span_ids }))
      : [],
    recommendations: registry
      ? [...new Set(registry.getMatchesForSpan(profile, span.id).map((m) => m.recommendation))]
      : [],
  };
}

function buildChildren(
  profile: Profile,
  parent: Span,
): ExplainSpanResult['children'] {
  const children: ExplainSpanResult['children'] = [];

  for (const childId of parent.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;

    const childName = (profile.frames[child.frame_index] as Frame | undefined)?.name ?? '<unknown>';
    const childCost = valuesToRecord(profile, child.values);

    const pctOfParent: Record<string, number> = {};
    for (let i = 0; i < profile.value_types.length; i++) {
      const key = profile.value_types[i].key;
      const parentVal = parent.values[i] ?? 0;
      const childVal = child.values[i] ?? 0;
      pctOfParent[key] =
        parentVal > 0 ? Math.round((childVal / parentVal) * 10000) / 100 : 0;
    }

    children.push({
      span_id: child.id,
      name: childName,
      cost: childCost,
      pct_of_parent: pctOfParent,
      error: child.error,
    });
  }

  // Sort by the first value type dimension (typically wall_ms), descending
  children.sort((a, b) => {
    const key = profile.value_types[0]?.key;
    if (!key) return 0;
    return (b.cost[key] ?? 0) - (a.cost[key] ?? 0);
  });

  return children;
}

function buildCausalChain(
  profile: Profile,
  parent: Span,
): ExplainSpanResult['causal_chain'] {
  const events: ExplainSpanResult['causal_chain'] = [];

  // Add child spans
  for (const childId of parent.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;

    const childName = (profile.frames[child.frame_index] as Frame | undefined)?.name ?? '<unknown>';
    const childKind = extractKind(childName);
    const childCost = valuesToRecord(profile, child.values);

    let eventDesc = childName;
    const duration = child.end_time - child.start_time;
    if (duration > 0) {
      eventDesc += ` (${formatDuration(duration)}`;
      const tokensIdx = profile.value_types.findIndex((vt) => vt.key === 'input_tokens');
      const inputTokens = tokensIdx >= 0 ? (child.values[tokensIdx] ?? 0) : 0;
      if (inputTokens > 0) eventDesc += `, ${inputTokens} tokens`;
      eventDesc += ')';
    }
    if (child.error) eventDesc += ` [ERROR: ${child.error}]`;

    events.push({
      timestamp: child.start_time,
      event: eventDesc,
      kind: childKind,
      cost: childCost,
    });
  }

  // Add markers that fall within the parent's time range
  for (const lane of profile.lanes) {
    for (const marker of lane.markers) {
      if (marker.timestamp >= parent.start_time && marker.timestamp <= parent.end_time) {
        events.push({
          timestamp: marker.timestamp,
          event: marker.name,
          kind: 'marker',
          cost: {},
        });
      }
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  return events;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function notFoundResult(): ExplainSpanResult {
  return {
    span: {
      name: '<not found>',
      kind: 'unknown',
      start_time: 0,
      end_time: 0,
      duration_ms: 0,
      cost: {},
      args: {},
    },
    ancestry: [],
    children: [],
    causal_chain: [],
    patterns: [],
    recommendations: [],
  };
}
