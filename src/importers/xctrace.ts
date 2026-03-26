import type { ImportedProfile } from './types.js';
import type { Lane, Span, ValueType } from '../model/types.js';
import type { XctraceRow } from './xctrace-xml.js';
import { parseXctraceXml } from './xctrace-xml.js';
import { discoverSchemas, exportSchema, KNOWN_SCHEMAS } from './xctrace-runner.js';
import { FrameTable } from '../model/frame-table.js';

const XCTRACE_VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
];

function gpuLaneId(eventType: string): string {
  const lower = eventType.toLowerCase();
  if (lower.includes('compute')) return 'gpu-compute';
  if (lower.includes('vertex') || lower.includes('tiling')) return 'gpu-vertex';
  if (lower.includes('fragment')) return 'gpu-fragment';
  return 'gpu-other';
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function getOrCreateLane(
  lanesMap: Map<string, Lane>,
  id: string,
  kind: Lane['kind'] = 'worker',
): Lane {
  let lane = lanesMap.get(id);
  if (!lane) {
    lane = { id, name: id, kind, samples: [], spans: [], markers: [] };
    lanesMap.set(id, lane);
  }
  return lane;
}

/**
 * Import from pre-parsed schema rows. This is the testable core.
 */
export function importXctraceRows(
  schemaRows: Map<string, XctraceRow[]>,
  name: string,
): ImportedProfile {
  const frameTable = new FrameTable();
  const lanesMap = new Map<string, Lane>();
  let spanIdCounter = 0;

  function nextSpanId(): string {
    return `xctrace_${spanIdCounter++}`;
  }

  // --- metal-gpu-intervals ---
  // XML tags: gpu-channel-name (Vertex/Fragment/Compute/Blit),
  // formatted-label (event label), process, start-time, duration
  const gpuRows = schemaRows.get('metal-gpu-intervals');
  if (gpuRows) {
    for (const row of gpuRows) {
      const startNs = Number(row['start-time'] ?? '0');
      const durationNs = Number(row['duration'] ?? '0');
      const channelName = row['gpu-channel-name'] ?? 'unknown';
      const label = row['formatted-label'] ?? channelName;

      const laneId = gpuLaneId(channelName);
      const lane = getOrCreateLane(lanesMap, laneId);

      const frameName = `${laneId}:${label}`;
      const frameIdx = frameTable.getOrInsert({ name: frameName });

      const wallMs = nsToMs(durationNs);
      const startMs = nsToMs(startNs);

      const span: Span = {
        id: nextSpanId(),
        frame_index: frameIdx,
        parent_id: null,
        start_time: startMs,
        end_time: startMs + wallMs,
        values: [wallMs],
        args: {
          channel: channelName,
          ...(row['process'] ? { process: row['process'] } : {}),
          start_ns: startNs,
          duration_ns: durationNs,
        },
        children: [],
      };

      lane.spans.push(span);
    }
  }

  // --- mps-hw-intervals ---
  // Same structure as metal-gpu-intervals but for MPS operations.
  // Uses mps-event-name for channel, formatted-label for detail.
  const mpsRows = schemaRows.get('mps-hw-intervals');
  if (mpsRows) {
    for (const row of mpsRows) {
      const startNs = Number(row['start-time'] ?? '0');
      const durationNs = Number(row['duration'] ?? '0');
      const channelName = row['mps-event-name'] || row['gpu-channel-name'] || 'Compute';
      const label = row['formatted-label'] ?? channelName;

      const laneId = gpuLaneId(channelName);
      const lane = getOrCreateLane(lanesMap, laneId);

      const frameName = `${laneId}:${label}`;
      const frameIdx = frameTable.getOrInsert({ name: frameName });

      const wallMs = nsToMs(durationNs);
      const startMs = nsToMs(startNs);

      const span: Span = {
        id: nextSpanId(),
        frame_index: frameIdx,
        parent_id: null,
        start_time: startMs,
        end_time: startMs + wallMs,
        values: [wallMs],
        args: {
          channel: channelName,
          schema: 'mps-hw-intervals',
          ...(row['process'] ? { process: row['process'] } : {}),
          start_ns: startNs,
          duration_ns: durationNs,
        },
        children: [],
      };

      lane.spans.push(span);
    }
  }

  // --- metal-driver-event-intervals ---
  // XML tags: gpu-driver-name (event type), gpu-driver-name:1 (sub-type),
  // formatted-label (detail), process, start-time, duration
  const driverRows = schemaRows.get('metal-driver-event-intervals');
  if (driverRows) {
    const lane = getOrCreateLane(lanesMap, 'driver', 'custom');
    for (const row of driverRows) {
      const startNs = Number(row['start-time'] ?? '0');
      const durationNs = Number(row['duration'] ?? '0');
      const driverEvent = row['gpu-driver-name'] ?? 'unknown';
      const label = row['formatted-label'] ?? driverEvent;

      const frameName = `driver:${driverEvent}`;
      const frameIdx = frameTable.getOrInsert({ name: frameName });

      const wallMs = nsToMs(durationNs);
      const startMs = nsToMs(startNs);

      const span: Span = {
        id: nextSpanId(),
        frame_index: frameIdx,
        parent_id: null,
        start_time: startMs,
        end_time: startMs + wallMs,
        values: [wallMs],
        args: {
          driver_event: driverEvent,
          label,
          ...(row['process'] ? { process: row['process'] } : {}),
          start_ns: startNs,
          duration_ns: durationNs,
        },
        children: [],
      };

      lane.spans.push(span);
    }
  }

  // --- os-signpost-interval ---
  const signpostRows = schemaRows.get('os-signpost-interval');
  if (signpostRows) {
    const lane = getOrCreateLane(lanesMap, 'signpost', 'custom');
    for (const row of signpostRows) {
      const startNs = Number(row['start-time'] ?? '0');
      const durationNs = Number(row['duration'] ?? '0');
      const subsystem = row['subsystem'] ?? '';
      const sigName = row['name'] ?? (row['message'] || 'signpost');

      const frameName = subsystem ? `signpost:${subsystem}:${sigName}` : `signpost:${sigName}`;
      const frameIdx = frameTable.getOrInsert({ name: frameName });

      const wallMs = nsToMs(durationNs);
      const startMs = nsToMs(startNs);

      const span: Span = {
        id: nextSpanId(),
        frame_index: frameIdx,
        parent_id: null,
        start_time: startMs,
        end_time: startMs + wallMs,
        values: [wallMs],
        args: {
          ...(subsystem ? { subsystem } : {}),
          start_ns: startNs,
          duration_ns: durationNs,
        },
        children: [],
      };

      lane.spans.push(span);
    }
  }

  const lanes = [...lanesMap.values()];

  return {
    format: 'xctrace',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: XCTRACE_VALUE_TYPES,
      categories: [],
      frames: [...frameTable.frames],
      lanes,
      metadata: { source_format: 'xctrace' },
    },
  };
}

/**
 * Import a .trace bundle by shelling out to xctrace.
 * Public entry point called from server.ts.
 */
export function importXctrace(
  tracePath: string,
  name: string,
): ImportedProfile {
  const allSchemas = discoverSchemas(tracePath);
  const relevantSchemas = KNOWN_SCHEMAS.filter((s) => allSchemas.includes(s));

  if (relevantSchemas.length === 0) {
    const available = allSchemas.length > 0
      ? `Available schemas: ${allSchemas.join(', ')}`
      : 'No schemas found in trace.';
    throw new Error(
      `No supported Metal/GPU schemas found in ${tracePath}. ${available}`,
    );
  }

  const schemaRows = new Map<string, XctraceRow[]>();
  for (const schema of relevantSchemas) {
    const xml = exportSchema(tracePath, schema);
    const rows = parseXctraceXml(xml);
    if (rows.length > 0) {
      schemaRows.set(schema, rows);
    }
  }

  return importXctraceRows(schemaRows, name);
}
