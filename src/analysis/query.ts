// src/analysis/query.ts
import type { Frame, Profile, Span } from '../model/types.js';

export interface TimeRange {
  start_ms: number;
  end_ms: number;
}

export function getAllSpans(profile: Profile): Span[] {
  const spans: Span[] = [];
  for (const lane of profile.lanes) {
    for (const span of lane.spans) {
      spans.push(span);
    }
  }
  return spans;
}

export function getSpanById(profile: Profile, spanId: string): Span | undefined {
  for (const lane of profile.lanes) {
    const span = lane.spans.find((s) => s.id === spanId);
    if (span) return span;
  }
  return undefined;
}

export function getSpanAncestry(profile: Profile, span: Span): string[] {
  const chain: string[] = [];
  let current: Span | undefined = span;
  while (current) {
    const frameName = (profile.frames[current.frame_index] as Frame | undefined)?.name;
    chain.push(frameName ?? `<unknown frame ${current.frame_index}>`);
    if (current.parent_id) {
      current = getSpanById(profile, current.parent_id);
    } else {
      current = undefined;
    }
  }
  chain.reverse();
  return chain;
}

export function computeSelfCost(profile: Profile, span: Span): number[] {
  if (span.children.length === 0) {
    return [...span.values];
  }
  const selfCost = [...span.values];
  for (const childId of span.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;
    for (let i = 0; i < selfCost.length; i++) {
      selfCost[i] -= child.values[i] ?? 0;
    }
  }
  for (let i = 0; i < selfCost.length; i++) {
    if (selfCost[i] < 0) selfCost[i] = 0;
  }
  return selfCost;
}

export function extractKind(frameName: string): string {
  const colonIdx = frameName.indexOf(':');
  return colonIdx >= 0 ? frameName.substring(0, colonIdx) : frameName;
}

export function filterSpansByTimeRange(
  spans: Span[],
  range: TimeRange | undefined,
): Span[] {
  if (!range) return spans;
  return spans.filter(
    (s) => s.end_time >= range.start_ms && s.start_time <= range.end_ms,
  );
}

/** Source location for LSP navigation. Format: "file:line" when available. */
export interface SourceLocation {
  file?: string;
  line?: number;
  /** Pre-formatted for LLM navigation: "file:line" or undefined if no source info. */
  ref?: string;
}

/** Extract source location from a frame, formatted for LSP navigation. */
export function getSourceLocation(profile: Profile, frameIndex: number): SourceLocation | undefined {
  const frame = profile.frames[frameIndex] as Frame | undefined;
  if (!frame) return undefined;
  if (!frame.file) return undefined;

  const loc: SourceLocation = { file: frame.file };
  if (frame.line != null) {
    loc.line = frame.line;
    loc.ref = `${frame.file}:${frame.line}`;
  } else {
    loc.ref = frame.file;
  }
  return loc;
}

/** Get source location for a span's frame. */
export function getSpanSourceLocation(profile: Profile, span: Span): SourceLocation | undefined {
  return getSourceLocation(profile, span.frame_index);
}

export function valuesToRecord(
  profile: Profile,
  values: number[],
): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < profile.value_types.length; i++) {
    record[profile.value_types[i].key] = values[i] ?? 0;
  }
  return record;
}
