// src/importers/chrome-trace.ts
import type { ImportedProfile } from './types.js';
import type { Span, Lane } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

interface TraceEvent {
  ph: string;
  name?: string;
  cat?: string;
  ts?: number;
  dur?: number;
  tdur?: number;
  pid?: number;
  tid?: number;
  s?: string;
  args?: Record<string, unknown>;
}

export function importChromeTrace(content: string, name: string): ImportedProfile {
  const parsed: unknown = JSON.parse(content);
  let events: TraceEvent[];

  if (Array.isArray(parsed)) {
    events = parsed as TraceEvent[];
  } else if (typeof parsed === 'object' && parsed !== null && 'traceEvents' in parsed) {
    events = (parsed as Record<string, unknown>)['traceEvents'] as TraceEvent[];
  } else {
    throw new Error('Invalid Chrome trace format');
  }

  const frameTable = new FrameTable();
  const lanesMap = new Map<string, { lane: Lane; openSpans: Map<string, Span[]>; nestingStack: Span[] }>();
  let spanIdCounter = 0;

  // First pass: collect M (metadata) events for lane names
  const laneNames = new Map<string, string>();
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args) {
      const key = `${event.pid ?? 0}:${event.tid ?? 0}`;
      const rawName = event.args['name'];
      laneNames.set(key, typeof rawName === 'string' ? rawName : key);
    }
    if (event.ph === 'M' && event.name === 'process_name' && event.args) {
      const key = `${event.pid ?? 0}:*`;
      if (!laneNames.has(key)) {
        const rawName = event.args['name'];
        laneNames.set(key, typeof rawName === 'string' ? rawName : '');
      }
    }
  }

  function getOrCreateLane(pid: number, tid: number): { lane: Lane; openSpans: Map<string, Span[]>; nestingStack: Span[] } {
    const key = `${pid}:${tid}`;
    let entry = lanesMap.get(key);
    if (!entry) {
      const laneName = laneNames.get(key) ?? laneNames.get(`${pid}:*`) ?? key;
      const lane: Lane = {
        id: key,
        name: laneName,
        pid,
        tid,
        kind: 'worker',
        samples: [],
        spans: [],
        markers: [],
      };
      entry = { lane, openSpans: new Map<string, Span[]>(), nestingStack: [] };
      lanesMap.set(key, entry);
    }
    return entry;
  }

  // Second pass: process events
  for (const event of events) {
    const pid = event.pid ?? 0;
    const tid = event.tid ?? 0;

    switch (event.ph) {
      case 'X': {
        const { lane } = getOrCreateLane(pid, tid);
        const frameIdx = frameTable.getOrInsert({ name: event.name ?? '<unknown>' });
        const startMs = (event.ts ?? 0) / 1000;
        const durMs = (event.dur ?? event.tdur ?? 0) / 1000;
        lane.spans.push({
          id: `imp_${spanIdCounter++}`,
          frame_index: frameIdx,
          parent_id: null,
          start_time: startMs,
          end_time: startMs + durMs,
          values: [durMs],
          args: event.args ?? {},
          children: [],
        });
        break;
      }
      case 'B': {
        const entry = getOrCreateLane(pid, tid);
        const frameIdx = frameTable.getOrInsert({ name: event.name ?? '<unknown>' });
        const startMs = (event.ts ?? 0) / 1000;
        const parentSpan = entry.nestingStack.length > 0 ? entry.nestingStack[entry.nestingStack.length - 1] : null;
        const span: Span = {
          id: `imp_${spanIdCounter++}`,
          frame_index: frameIdx,
          parent_id: parentSpan ? parentSpan.id : null,
          start_time: startMs,
          end_time: startMs,
          values: [0],
          args: event.args ?? {},
          children: [],
        };
        if (parentSpan) {
          parentSpan.children.push(span.id);
        }
        entry.lane.spans.push(span);
        entry.nestingStack.push(span);
        const eventName = event.name ?? '';
        let stack = entry.openSpans.get(eventName);
        if (!stack) {
          stack = [];
          entry.openSpans.set(eventName, stack);
        }
        stack.push(span);
        break;
      }
      case 'E': {
        const entry = getOrCreateLane(pid, tid);
        const eventName = event.name ?? '';
        const stack = entry.openSpans.get(eventName);
        if (stack && stack.length > 0) {
          const openSpan = stack.pop();
          if (openSpan) {
            const endMs = (event.ts ?? 0) / 1000;
            openSpan.end_time = endMs;
            openSpan.values = [endMs - openSpan.start_time];
            // Pop from nesting stack — find and remove this span
            const nestIdx = entry.nestingStack.lastIndexOf(openSpan);
            if (nestIdx !== -1) {
              entry.nestingStack.splice(nestIdx, 1);
            }
          }
          if (stack.length === 0) {
            entry.openSpans.delete(eventName);
          }
        }
        break;
      }
      case 'I':
      case 'i': {
        const { lane } = getOrCreateLane(pid, tid);
        lane.markers.push({
          timestamp: (event.ts ?? 0) / 1000,
          name: event.name ?? '<unknown>',
          data: event.args,
        });
        break;
      }
    }
  }

  // Post-process: assign parent_id for unparented spans using containment-based nesting
  for (const entry of lanesMap.values()) {
    const spans = entry.lane.spans;
    // Only consider spans not already parented by B/E logic
    const xSpans = spans.filter((s) => s.parent_id === null);
    // Sort by start_time asc, then by duration desc (so parent comes before child at same start)
    xSpans.sort((a, b) => {
      const startDiff = a.start_time - b.start_time;
      if (startDiff !== 0) return startDiff;
      return (b.end_time - b.start_time) - (a.end_time - a.start_time);
    });

    const nestStack: Span[] = [];
    for (const span of xSpans) {
      // Pop spans from stack whose end time <= current span's start time
      while (nestStack.length > 0 && nestStack[nestStack.length - 1].end_time <= span.start_time) {
        nestStack.pop();
      }
      if (nestStack.length > 0) {
        const parent = nestStack[nestStack.length - 1];
        span.parent_id = parent.id;
        parent.children.push(span.id);
      }
      nestStack.push(span);
    }
  }

  const lanes = [...lanesMap.values()].map((e) => e.lane);
  if (lanes.length > 0) {
    lanes[0].kind = 'main';
  }

  return {
    format: 'chrome_trace',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: [{ key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' }],
      categories: [],
      frames: [...frameTable.frames],
      lanes,
      metadata: { source_format: 'chrome_trace' },
    },
  };
}
