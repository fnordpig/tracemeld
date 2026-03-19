// src/instrument/trace.ts
import type { ProfilerState } from '../model/state.js';

export interface TraceInput {
  action: 'begin' | 'end';
  kind: string;
  name?: string;
  cost?: Record<string, number>;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceResult {
  span_id: string;
  depth: number;
  elapsed_ms?: number;
  parent_id?: string;
}

export function handleTrace(state: ProfilerState, input: TraceInput): TraceResult {
  const laneId = state.activeLaneId;

  if (input.action === 'begin') {
    return handleBegin(state, laneId, input);
  } else {
    return handleEnd(state, laneId, input);
  }
}

function handleBegin(state: ProfilerState, laneId: string, input: TraceInput): TraceResult {
  const frameName = input.name ? `${input.kind}:${input.name}` : input.kind;
  const frameIdx = state.builder.frameTable.getOrInsert({ name: frameName });
  const spanId = state.nextSpanId();
  const parentId = state.currentSpanId(laneId);
  const now = Date.now();

  state.builder.addSpan(laneId, {
    id: spanId,
    frame_index: frameIdx,
    parent_id: parentId,
    start_time: now,
    end_time: now, // will be updated on end
    values: state.builder.emptyValues(),
    args: input.metadata ? { ...input.metadata } : {},
    children: [],
  });

  // Update parent's children list
  if (parentId) {
    const lane = state.builder.getLane(laneId);
    const parent = lane?.spans.find((s) => s.id === parentId);
    if (parent) parent.children.push(spanId);
  }

  state.pushSpan(laneId, spanId);

  return {
    span_id: spanId,
    depth: state.spanDepth(laneId),
    parent_id: parentId ?? undefined,
  };
}

function handleEnd(state: ProfilerState, laneId: string, input: TraceInput): TraceResult {
  const lane = state.builder.getLane(laneId);
  if (!lane) return { span_id: '', depth: 0 };

  const currentId = state.currentSpanId(laneId);
  if (!currentId) return { span_id: '', depth: 0 };

  // Find the span matching this kind
  const targetKind = input.name ? `${input.kind}:${input.name}` : input.kind;

  // Check if current stack top matches
  const topSpan = lane.spans.find((s) => s.id === currentId);
  if (!topSpan) return { span_id: '', depth: 0 };

  const topFrameName = state.builder.profile.frames[topSpan.frame_index]?.name;

  if (topFrameName !== targetKind && !topFrameName.startsWith(`${input.kind}:`)) {
    // Mismatch: auto-close spans until we find a match or exhaust the stack
    autoCloseUntilMatch(state, laneId, input.kind);
  }

  // Now close the current top
  const spanId = state.currentSpanId(laneId);
  if (!spanId) return { span_id: '', depth: 0 };

  const span = lane.spans.find((s) => s.id === spanId);
  if (!span) return { span_id: '', depth: 0 };

  const now = Date.now();
  span.end_time = now;
  const elapsed = now - span.start_time;

  if (input.cost) {
    state.builder.mergeCost(span.values, input.cost);
  }
  if (input.error) {
    span.error = input.error;
  }
  if (input.metadata) {
    Object.assign(span.args, input.metadata);
  }

  state.popSpan(laneId);

  return {
    span_id: span.id,
    depth: state.spanDepth(laneId),
    elapsed_ms: elapsed,
  };
}

function autoCloseUntilMatch(state: ProfilerState, laneId: string, kind: string): void {
  const lane = state.builder.getLane(laneId);
  if (!lane) return;

  // Close spans from the top until we find one matching the kind
  let safety = 100;
  while (safety-- > 0) {
    const topId = state.currentSpanId(laneId);
    if (!topId) break;

    const topSpan = lane.spans.find((s) => s.id === topId);
    if (!topSpan) break;

    const frameName = state.builder.profile.frames[topSpan.frame_index]?.name ?? '';
    if (frameName === kind || frameName.startsWith(`${kind}:`)) {
      break; // Found the match, stop auto-closing
    }

    // Auto-close this span
    topSpan.end_time = Date.now();
    topSpan.args['auto_closed'] = true;
    state.popSpan(laneId);
  }
}
