// src/exporters/chrome-trace.ts
import type { Profile, ValueType } from '../model/types.js';

interface ChromeTraceEvent {
  ph: string;
  name: string;
  cat?: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  s?: string;
  args?: Record<string, unknown>;
}

interface ChromeTraceFile {
  traceEvents: ChromeTraceEvent[];
}

export interface ChromeTraceExportOptions {
  include_idle?: boolean;
}

/**
 * Convert a span's multi-dimensional values array into a keyed record
 * using the profile's value_types for labels.
 */
function valuesToRecord(
  values: number[],
  valueTypes: ValueType[],
): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < values.length; i++) {
    const key = valueTypes[i]?.key ?? `dim_${i}`;
    record[key] = values[i];
  }
  return record;
}

export function exportChromeTrace(
  profile: Profile,
  options?: ChromeTraceExportOptions,
): object {
  const includeIdle = options?.include_idle ?? false;
  const traceEvents: ChromeTraceEvent[] = [];

  for (let laneIndex = 0; laneIndex < profile.lanes.length; laneIndex++) {
    const lane = profile.lanes[laneIndex];
    const pid = lane.pid ?? laneIndex;
    const tid = lane.tid ?? 0;

    // Emit M (metadata) events for lane name
    traceEvents.push({
      ph: 'M',
      name: 'process_name',
      pid,
      tid,
      ts: 0,
      args: { name: lane.name },
    });
    traceEvents.push({
      ph: 'M',
      name: 'thread_name',
      pid,
      tid,
      ts: 0,
      args: { name: lane.name },
    });

    // Emit X (complete) events for spans
    for (const span of lane.spans) {
      const frame = profile.frames[span.frame_index] as typeof profile.frames[number] | undefined;
      if (!frame) continue;

      // Idle filtering: skip spans whose frame name starts with "user_input:"
      if (!includeIdle && frame.name.startsWith('user_input:')) {
        continue;
      }

      const category =
        frame.category_index != null && profile.categories[frame.category_index]
          ? profile.categories[frame.category_index].name
          : 'default';

      const args: Record<string, unknown> = {
        ...span.args,
        values: valuesToRecord(span.values, profile.value_types),
      };

      traceEvents.push({
        ph: 'X',
        name: frame.name,
        cat: category,
        ts: span.start_time * 1000,
        dur: (span.end_time - span.start_time) * 1000,
        pid,
        tid,
        args,
      });
    }

    // Emit i (instant) events for markers
    for (const marker of lane.markers) {
      traceEvents.push({
        ph: 'i',
        name: marker.name,
        ts: marker.timestamp * 1000,
        pid,
        tid,
        s: 't',
        args: marker.data,
      });
    }
  }

  const file: ChromeTraceFile = { traceEvents };
  return file;
}
