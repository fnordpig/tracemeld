// src/analysis/starvations.ts
import type { Profile } from '../model/types.js';

export interface StarvationsInput {
  min_idle_pct?: number;
}

export interface CompressedIdleRange {
  start_ms: number;
  end_ms: number;
  count: number;
  min_duration_ms: number;
  max_duration_ms: number;
  total_duration_ms: number;
}

export interface StarvationEntry {
  lane_id: string;
  lane_name: string;
  idle_ms: number;
  active_window_ms: number;
  idle_pct: number;
  idle_ranges: CompressedIdleRange[];
  recommendation: string;
}

export interface StarvationsResult {
  entries: StarvationEntry[];
}

export function findStarvations(profile: Profile, input: StarvationsInput): StarvationsResult {
  const minIdlePct = input.min_idle_pct ?? 50;
  const activeLanes = profile.lanes.filter((l) => l.spans.length > 0 || l.samples.length > 0);
  if (activeLanes.length < 2) return { entries: [] };

  let globalStart = Infinity;
  let globalEnd = 0;
  for (const lane of activeLanes) {
    for (const span of lane.spans) {
      if (span.start_time < globalStart) globalStart = span.start_time;
      if (span.end_time > globalEnd) globalEnd = span.end_time;
    }
  }
  if (globalStart >= globalEnd) return { entries: [] };

  const activeWindowMs = globalEnd - globalStart;
  const entries: StarvationEntry[] = [];

  for (const lane of activeLanes) {
    const busyIntervals = lane.spans
      .map((s) => ({ start: s.start_time, end: s.end_time }))
      .sort((a, b) => a.start - b.start);

    const merged = mergeIntervals(busyIntervals);

    const idleRanges: Array<{ start_ms: number; end_ms: number; duration_ms: number }> = [];
    let cursor = globalStart;
    for (const interval of merged) {
      if (interval.start > cursor) {
        idleRanges.push({
          start_ms: cursor,
          end_ms: interval.start,
          duration_ms: interval.start - cursor,
        });
      }
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < globalEnd) {
      idleRanges.push({ start_ms: cursor, end_ms: globalEnd, duration_ms: globalEnd - cursor });
    }

    const idleMs = idleRanges.reduce((sum, r) => sum + r.duration_ms, 0);
    const idlePct = activeWindowMs > 0 ? (idleMs / activeWindowMs) * 100 : 0;

    if (idlePct >= minIdlePct) {
      entries.push({
        lane_id: lane.id,
        lane_name: lane.name,
        idle_ms: Math.round(idleMs),
        active_window_ms: Math.round(activeWindowMs),
        idle_pct: Math.round(idlePct * 100) / 100,
        idle_ranges: compressIdleRanges(idleRanges),
        recommendation: `Lane '${lane.name}' was idle ${Math.round(idlePct)}% of the time while other lanes were active. This may indicate lock contention, unbalanced work distribution, or serialization.`,
      });
    }
  }

  entries.sort((a, b) => b.idle_pct - a.idle_pct);
  return { entries };
}

const EPSILON_MS = 1;

function compressIdleRanges(
  ranges: Array<{ start_ms: number; end_ms: number; duration_ms: number }>,
): CompressedIdleRange[] {
  if (ranges.length === 0) return [];

  const result: CompressedIdleRange[] = [];
  let group: CompressedIdleRange = {
    start_ms: Math.round(ranges[0].start_ms),
    end_ms: Math.round(ranges[0].end_ms),
    count: 1,
    min_duration_ms: Math.round(ranges[0].duration_ms),
    max_duration_ms: Math.round(ranges[0].duration_ms),
    total_duration_ms: Math.round(ranges[0].duration_ms),
  };

  for (let i = 1; i < ranges.length; i++) {
    const dur = Math.round(ranges[i].duration_ms);
    if (Math.abs(dur - group.min_duration_ms) <= EPSILON_MS &&
        Math.abs(dur - group.max_duration_ms) <= EPSILON_MS) {
      // Extend the current group
      group.end_ms = Math.round(ranges[i].end_ms);
      group.count++;
      group.min_duration_ms = Math.min(group.min_duration_ms, dur);
      group.max_duration_ms = Math.max(group.max_duration_ms, dur);
      group.total_duration_ms += dur;
    } else {
      result.push(group);
      group = {
        start_ms: Math.round(ranges[i].start_ms),
        end_ms: Math.round(ranges[i].end_ms),
        count: 1,
        min_duration_ms: dur,
        max_duration_ms: dur,
        total_duration_ms: dur,
      };
    }
  }
  result.push(group);
  return result;
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (intervals.length === 0) return [];
  const result: Array<{ start: number; end: number }> = [{ ...intervals[0] }];
  for (let i = 1; i < intervals.length; i++) {
    const last = result[result.length - 1];
    if (intervals[i].start <= last.end) {
      last.end = Math.max(last.end, intervals[i].end);
    } else {
      result.push({ ...intervals[i] });
    }
  }
  return result;
}
