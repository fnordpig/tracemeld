// src/analysis/focus-function.ts
import type { Frame, Profile, Span } from '../model/types.js';
import {
  getAllSpans,
  buildSpanIndex,
  getSpanById,
  computeSelfCost,
  valuesToRecord,
  getSourceLocation,
  aggregateSamplesByFrame,
  type SourceLocation,
} from './query.js';

export interface FocusFunctionInput {
  function_name: string;
  dimension?: string;
  top_n?: number;
}

interface RelatedFunction {
  name: string;
  frame_index: number;
  code_location?: SourceLocation;
  call_count: number;
  total_cost: Record<string, number>;
  pct_of_function_time: number;
}

export interface FocusFunctionResult {
  function_name: string;
  frame_index: number;
  code_location?: SourceLocation;
  self_cost: Record<string, number>;
  total_cost: Record<string, number>;
  sample_count: number;
  span_count: number;
  callers: RelatedFunction[];
  callees: RelatedFunction[];
  investigate: string;
}

export interface FocusFunctionNotFound {
  error: string;
  available_frames: string[];
}

export function focusFunction(
  profile: Profile,
  input: FocusFunctionInput,
): FocusFunctionResult | FocusFunctionNotFound {
  const topN = input.top_n ?? 10;
  let dim = input.dimension;
  if (!dim) {
    dim = profile.value_types[0]?.key ?? 'wall_ms';
  }
  const dimIndex = profile.value_types.findIndex((vt) => vt.key === dim);

  // Find matching frame(s) — exact match first, then substring
  const targetFrameIndices = findMatchingFrames(profile, input.function_name);

  if (targetFrameIndices.length === 0) {
    const frameNames = [...new Set(profile.frames.map((f) => f.name))];
    frameNames.sort();
    return {
      error: `No function matching '${input.function_name}' found in the profile.`,
      available_frames: frameNames.slice(0, 30),
    };
  }

  const targetSet = new Set(targetFrameIndices);
  const primaryIdx = targetFrameIndices[0];
  const primaryFrame = profile.frames[primaryIdx];

  // Aggregate stats from samples
  const frameStats = aggregateSamplesByFrame(profile);
  const sampleSelfCost = new Array<number>(profile.value_types.length).fill(0);
  const sampleTotalCost = new Array<number>(profile.value_types.length).fill(0);
  let sampleCount = 0;
  for (const fs of frameStats) {
    if (targetSet.has(fs.frame_index)) {
      for (let i = 0; i < sampleSelfCost.length; i++) {
        sampleSelfCost[i] += fs.self_cost[i] ?? 0;
        sampleTotalCost[i] += fs.total_cost[i] ?? 0;
      }
      sampleCount += fs.sample_count;
    }
  }

  // Aggregate stats from spans
  const allSpans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);
  const spanSelfCost = new Array<number>(profile.value_types.length).fill(0);
  const spanTotalCost = new Array<number>(profile.value_types.length).fill(0);
  let spanCount = 0;
  const targetSpans: Span[] = [];
  for (const span of allSpans) {
    if (targetSet.has(span.frame_index)) {
      const selfCost = computeSelfCost(profile, span, spanIndex);
      // Total cost: use span values, or sum children if span has no explicit cost
      const spanTotal = computeInclusiveCost(profile, span, spanIndex);
      for (let i = 0; i < spanSelfCost.length; i++) {
        spanSelfCost[i] += selfCost[i] ?? 0;
        spanTotalCost[i] += spanTotal[i] ?? 0;
      }
      spanCount++;
      targetSpans.push(span);
    }
  }

  // Combined costs
  const totalSelfCost = sampleSelfCost.map((v, i) => v + spanSelfCost[i]);
  const totalTotalCost = sampleTotalCost.map((v, i) => v + spanTotalCost[i]);

  // The function's total in the ranking dimension (for percentage calculations)
  const functionTotal = dimIndex >= 0 ? (totalTotalCost[dimIndex] ?? 0) : 0;

  // --- Callers ---
  const callerAgg = new Map<number, { cost: number[]; count: number }>();

  // From samples: caller is the frame immediately before target in stack
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      for (let i = 0; i < sample.stack.length; i++) {
        if (targetSet.has(sample.stack[i]) && i > 0) {
          const callerIdx = sample.stack[i - 1];
          accumulateRelation(callerAgg, callerIdx, sample.values, profile.value_types.length);
        }
      }
    }
  }

  // From spans: caller is the parent span's frame
  for (const span of targetSpans) {
    if (span.parent_id) {
      const parent = getSpanById(profile, span.parent_id, spanIndex);
      if (parent) {
        accumulateRelation(callerAgg, parent.frame_index, span.values, profile.value_types.length);
      }
    }
  }

  const callers = buildRankedList(callerAgg, profile, dimIndex, functionTotal, topN);

  // --- Callees ---
  const calleeAgg = new Map<number, { cost: number[]; count: number }>();

  // From samples: callee is the frame immediately after target in stack
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      for (let i = 0; i < sample.stack.length; i++) {
        if (targetSet.has(sample.stack[i]) && i < sample.stack.length - 1) {
          const calleeIdx = sample.stack[i + 1];
          accumulateRelation(calleeAgg, calleeIdx, sample.values, profile.value_types.length);
        }
      }
    }
  }

  // From spans: callees are the children of target spans
  for (const span of targetSpans) {
    for (const childId of span.children) {
      const child = getSpanById(profile, childId, spanIndex);
      if (child) {
        accumulateRelation(calleeAgg, child.frame_index, child.values, profile.value_types.length);
      }
    }
  }

  const callees = buildRankedList(calleeAgg, profile, dimIndex, functionTotal, topN);

  const source = getSourceLocation(profile, primaryIdx);
  const investigateHint = source?.ref
    ? `Read ${source.ref} to understand this function. Use hotpaths to see the full call chains it participates in.`
    : `Use hotpaths to see the full call chains this function participates in.`;

  return {
    function_name: primaryFrame.name,
    frame_index: primaryIdx,
    code_location: source,
    self_cost: valuesToRecord(profile, totalSelfCost),
    total_cost: valuesToRecord(profile, totalTotalCost),
    sample_count: sampleCount,
    span_count: spanCount,
    callers,
    callees,
    investigate: investigateHint,
  };
}

/** Get inclusive cost for a span: its own values, or sum of children if values are all zero. */
function computeInclusiveCost(profile: Profile, span: Span, index: Map<string, Span>): number[] {
  const hasOwnCost = span.values.some((v) => v > 0);
  if (hasOwnCost) return span.values;
  // Wrapper span with no explicit cost — sum children
  const total = new Array<number>(profile.value_types.length).fill(0);
  for (const childId of span.children) {
    const child = getSpanById(profile, childId, index);
    if (!child) continue;
    const childCost = computeInclusiveCost(profile, child, index);
    for (let i = 0; i < total.length; i++) {
      total[i] += childCost[i] ?? 0;
    }
  }
  return total;
}

function findMatchingFrames(profile: Profile, name: string): number[] {
  // Exact match
  const exact: number[] = [];
  const substring: number[] = [];
  const lowerName = name.toLowerCase();
  for (let i = 0; i < profile.frames.length; i++) {
    const frame = profile.frames[i];
    if (frame.name === name) {
      exact.push(i);
    } else if (frame.name.toLowerCase().includes(lowerName)) {
      substring.push(i);
    }
  }
  return exact.length > 0 ? exact : substring;
}

function accumulateRelation(
  map: Map<number, { cost: number[]; count: number }>,
  frameIdx: number,
  values: number[],
  vtLen: number,
): void {
  let entry = map.get(frameIdx);
  if (!entry) {
    entry = { cost: new Array<number>(vtLen).fill(0), count: 0 };
    map.set(frameIdx, entry);
  }
  entry.count++;
  for (let i = 0; i < vtLen; i++) {
    entry.cost[i] += values[i] ?? 0;
  }
}

function buildRankedList(
  agg: Map<number, { cost: number[]; count: number }>,
  profile: Profile,
  dimIndex: number,
  functionTotal: number,
  topN: number,
): RelatedFunction[] {
  const entries: RelatedFunction[] = [];
  for (const [frameIdx, entry] of agg) {
    const frame = profile.frames[frameIdx] as Frame | undefined;
    const dimCost = dimIndex >= 0 ? (entry.cost[dimIndex] ?? 0) : 0;
    const pct = functionTotal > 0
      ? Math.round((dimCost / functionTotal) * 10000) / 100
      : 0;
    entries.push({
      name: frame?.name ?? `<unknown ${frameIdx}>`,
      frame_index: frameIdx,
      code_location: getSourceLocation(profile, frameIdx),
      call_count: entry.count,
      total_cost: valuesToRecord(profile, entry.cost),
      pct_of_function_time: pct,
    });
  }

  // Sort by dimension cost descending
  if (dimIndex >= 0) {
    const dimKey = profile.value_types[dimIndex].key;
    entries.sort((a, b) => (b.total_cost[dimKey] ?? 0) - (a.total_cost[dimKey] ?? 0));
  }

  return entries.slice(0, topN);
}
