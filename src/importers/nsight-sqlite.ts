// src/importers/nsight-sqlite.ts
import initSqlJs, { type Database } from 'sql.js';
import type { ImportedProfile } from './types.js';
import type { Lane, Span, ValueType } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

export interface NsightImportOptions {
  max_kernels?: number;
  time_range?: { start_ns: number; end_ns: number };
}

// Value type indices
const V_WALL_MS = 0;
const V_BYTES = 1;
const V_THREADS = 2;
const V_SHARED_MEM = 3;
const V_REGISTERS = 4;

const NSIGHT_VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
  { key: 'bytes', unit: 'bytes', description: 'Memory transfer size' },
  { key: 'threads', unit: 'none', description: 'Thread count (grid * block)' },
  { key: 'shared_mem_bytes', unit: 'bytes', description: 'Shared memory per block' },
  { key: 'registers', unit: 'none', description: 'Registers per thread' },
];

function vals(count: number = NSIGHT_VALUE_TYPES.length): number[] {
  return new Array<number>(count).fill(0);
}

const COPY_KIND_LABELS: Record<number, string> = {
  1: 'HtoD',
  2: 'DtoH',
  3: 'HtoH',
  4: 'DtoD',
  10: 'Peer',
};

function tableExists(db: Database, tableName: string): boolean {
  const result = db.exec(
    `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
  );
  return result.length > 0 && (result[0].values[0][0] as number) > 0;
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function buildStringMap(db: Database): Map<number, string> {
  const map = new Map<number, string>();
  if (!tableExists(db, 'StringIds')) return map;
  const result = db.exec('SELECT id, value FROM StringIds');
  if (result.length === 0) return map;
  for (const row of result[0].values) {
    map.set(row[0] as number, row[1] as string);
  }
  return map;
}

function timeRangeFilter(
  options: NsightImportOptions | undefined,
  startCol: string,
  endCol: string,
): string {
  if (!options?.time_range) return '';
  return ` AND ${endCol} >= ${options.time_range.start_ns} AND ${startCol} <= ${options.time_range.end_ns}`;
}

function getOrCreateLane(
  lanesMap: Map<string, Lane>,
  id: string,
  name: string,
  kind: Lane['kind'],
): Lane {
  let lane = lanesMap.get(id);
  if (!lane) {
    lane = { id, name, kind, samples: [], spans: [], markers: [] };
    lanesMap.set(id, lane);
  }
  return lane;
}

export async function importNsightSqlite(
  data: Uint8Array,
  name: string,
  options?: NsightImportOptions,
): Promise<ImportedProfile> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(data);

  try {
    const stringMap = buildStringMap(db);
    const frameTable = new FrameTable();
    const lanesMap = new Map<string, Lane>();
    const correlationMap = new Map<number, string>(); // correlationId → spanId
    let spanIdCounter = 0;

    function nextSpanId(): string {
      return `nsight_${spanIdCounter++}`;
    }

    function resolveName(nameId: number | null, fallback?: string | null): string {
      if (nameId !== null) {
        const resolved = stringMap.get(nameId);
        if (resolved) return resolved;
      }
      return fallback ?? '<unknown>';
    }

    // --- CUPTI_ACTIVITY_KIND_RUNTIME ---
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_RUNTIME')) {
      const lane = getOrCreateLane(lanesMap, 'cuda-runtime', 'cuda-runtime', 'custom');
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT nameId, start, end, correlationId FROM CUPTI_ACTIVITY_KIND_RUNTIME WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const nameId = row[0] as number;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const correlationId = row[3] as number;
          const apiName = resolveName(nameId);
          const frameIdx = frameTable.getOrInsert({ name: `cuda_api:${apiName}` });
          const wallMs = nsToMs(endNs - startNs);
          const spanId = nextSpanId();
          const v = vals();
          v[V_WALL_MS] = wallMs;
          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: null,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { correlationId, start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);
          correlationMap.set(correlationId, spanId);
        }
      }
    }

    // --- CUPTI_ACTIVITY_KIND_KERNEL ---
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_KERNEL')) {
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT demangledName, start, end, deviceId, streamId, contextId, correlationId,
                gridX, gridY, gridZ, blockX, blockY, blockZ,
                staticSharedMemory, dynamicSharedMemory, registersPerThread
         FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        let kernelCount = 0;
        for (const row of result[0].values) {
          if (options?.max_kernels && kernelCount >= options.max_kernels) {
            // Add warning marker to the kernel lane being truncated
            const deviceId = row[3] as number;
            const kernelLane = getOrCreateLane(
              lanesMap,
              `gpu-${deviceId}-kernels`,
              `gpu-${deviceId}-kernels`,
              'worker',
            );
            kernelLane.markers.push({
              timestamp: nsToMs(row[1] as number),
              name: `Truncated: imported ${kernelCount} of ${result[0].values.length} kernel events (max_kernels=${options.max_kernels})`,
              severity: 'warning',
            });
            break;
          }

          const demangledName = row[0] as number | string;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const deviceId = row[3] as number;
          const streamId = row[4] as number;
          const contextId = row[5] as number;
          const correlationId = row[6] as number;
          const gridX = row[7] as number;
          const gridY = row[8] as number;
          const gridZ = row[9] as number;
          const blockX = row[10] as number;
          const blockY = row[11] as number;
          const blockZ = row[12] as number;
          const staticShared = row[13] as number;
          const dynamicShared = row[14] as number;
          const registers = row[15] as number;

          const kernelName =
            typeof demangledName === 'string'
              ? demangledName
              : resolveName(demangledName);
          const laneId = `gpu-${deviceId}-kernels`;
          const lane = getOrCreateLane(lanesMap, laneId, laneId, 'worker');
          const frameIdx = frameTable.getOrInsert({ name: `kernel:${kernelName}` });

          const gridDim = [gridX, gridY, gridZ];
          const blockDim = [blockX, blockY, blockZ];
          const threads = gridX * gridY * gridZ * blockX * blockY * blockZ;
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;
          v[V_THREADS] = threads;
          v[V_SHARED_MEM] = staticShared + dynamicShared;
          v[V_REGISTERS] = registers;

          const spanId = nextSpanId();
          const parentSpanId = correlationMap.get(correlationId) ?? null;

          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: parentSpanId,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: {
              deviceId,
              streamId,
              contextId,
              correlationId,
              gridDim,
              blockDim,
              start_ns: startNs,
              end_ns: endNs,
            },
            children: [],
          };
          lane.spans.push(span);

          // Link to parent runtime span
          if (parentSpanId) {
            const runtimeLane = lanesMap.get('cuda-runtime');
            if (runtimeLane) {
              const parentSpan = runtimeLane.spans.find((s) => s.id === parentSpanId);
              if (parentSpan) {
                parentSpan.children.push(spanId);
              }
            }
          }

          kernelCount++;
        }
      }
    }

    // --- CUPTI_ACTIVITY_KIND_MEMCPY ---
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_MEMCPY')) {
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT copyKind, start, end, deviceId, streamId, correlationId, bytes
         FROM CUPTI_ACTIVITY_KIND_MEMCPY WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const copyKind = row[0] as number;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const deviceId = row[3] as number;
          const streamId = row[4] as number;
          const correlationId = row[5] as number;
          const bytes = row[6] as number;

          const kindLabel = COPY_KIND_LABELS[copyKind] ?? `kind${copyKind}`;
          const laneId = `gpu-${deviceId}-memory`;
          const lane = getOrCreateLane(lanesMap, laneId, laneId, 'worker');
          const frameIdx = frameTable.getOrInsert({ name: `memcpy:${kindLabel}` });
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;
          v[V_BYTES] = bytes;

          const spanId = nextSpanId();
          const parentSpanId = correlationMap.get(correlationId) ?? null;

          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: parentSpanId,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { deviceId, streamId, correlationId, copyKind, bytes, start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);

          if (parentSpanId) {
            const runtimeLane = lanesMap.get('cuda-runtime');
            if (runtimeLane) {
              const parentSpan = runtimeLane.spans.find((s) => s.id === parentSpanId);
              if (parentSpan) {
                parentSpan.children.push(spanId);
              }
            }
          }
        }
      }
    }

    // --- CUPTI_ACTIVITY_KIND_MEMSET ---
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_MEMSET')) {
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT start, end, deviceId, correlationId, bytes
         FROM CUPTI_ACTIVITY_KIND_MEMSET WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const startNs = row[0] as number;
          const endNs = row[1] as number;
          const deviceId = row[2] as number;
          const correlationId = row[3] as number;
          const bytes = row[4] as number;

          const laneId = `gpu-${deviceId}-memory`;
          const lane = getOrCreateLane(lanesMap, laneId, laneId, 'worker');
          const frameIdx = frameTable.getOrInsert({ name: 'memset' });
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;
          v[V_BYTES] = bytes;

          const spanId = nextSpanId();
          const parentSpanId = correlationMap.get(correlationId) ?? null;

          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: parentSpanId,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { deviceId, correlationId, bytes, start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);

          if (parentSpanId) {
            const runtimeLane = lanesMap.get('cuda-runtime');
            if (runtimeLane) {
              const parentSpan = runtimeLane.spans.find((s) => s.id === parentSpanId);
              if (parentSpan) {
                parentSpan.children.push(spanId);
              }
            }
          }
        }
      }
    }

    // --- CUPTI_ACTIVITY_KIND_SYNCHRONIZATION ---
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_SYNCHRONIZATION')) {
      const lane = getOrCreateLane(lanesMap, 'cuda-runtime', 'cuda-runtime', 'custom');
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT nameId, start, end, correlationId FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const nameId = row[0] as number;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const correlationId = row[3] as number;
          const syncName = resolveName(nameId);
          const frameIdx = frameTable.getOrInsert({ name: `cuda_sync:${syncName}` });
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;

          const spanId = nextSpanId();
          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: null,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { correlationId, start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);
        }
      }
    }

    // --- NVTX_EVENTS ---
    if (tableExists(db, 'NVTX_EVENTS')) {
      const nvtxLane = getOrCreateLane(lanesMap, 'nvtx', 'nvtx', 'custom');
      const filter = timeRangeFilter(options, 'start', 'end');

      // Ranges: eventType 59 (push) / 60 (pop) — but Nsight stores completed ranges as single rows
      // with start/end and eventType 59 or 60. In practice, ranges appear as eventType 59 with start+end.
      const rangeResult = db.exec(
        `SELECT textId, text, start, end, eventType FROM NVTX_EVENTS WHERE eventType IN (59, 60)${filter}`,
      );
      if (rangeResult.length > 0) {
        for (const row of rangeResult[0].values) {
          const textId = row[0] as number | null;
          const rawText = row[1] as string | null;
          const startNs = row[2] as number;
          const endNs = row[3] as number | null;

          let text: string;
          if (textId !== null) {
            text = stringMap.get(textId) ?? rawText ?? '<unknown>';
          } else {
            text = rawText ?? '<unknown>';
          }

          if (endNs !== null) {
            const frameIdx = frameTable.getOrInsert({ name: `nvtx:${text}` });
            const wallMs = nsToMs(endNs - startNs);
            const v = vals();
            v[V_WALL_MS] = wallMs;
            const spanId = nextSpanId();
            const span: Span = {
              id: spanId,
              frame_index: frameIdx,
              parent_id: null,
              start_time: nsToMs(startNs),
              end_time: nsToMs(endNs),
              values: v,
              args: { start_ns: startNs, end_ns: endNs },
              children: [],
            };
            nvtxLane.spans.push(span);
          }
        }
      }

      // Marks: eventType 34 (instant events — filter on start only)
      const markFilter = timeRangeFilter(options, 'start', 'start');
      const markResult = db.exec(
        `SELECT textId, text, start FROM NVTX_EVENTS WHERE eventType = 34${markFilter}`,
      );
      if (markResult.length > 0) {
        for (const row of markResult[0].values) {
          const textId = row[0] as number | null;
          const rawText = row[1] as string | null;
          const timestamp = row[2] as number;

          let text: string;
          if (textId !== null) {
            text = stringMap.get(textId) ?? rawText ?? '<unknown>';
          } else {
            text = rawText ?? '<unknown>';
          }

          nvtxLane.markers.push({
            timestamp: nsToMs(timestamp),
            name: `nvtx_mark:${text}`,
          });
        }
      }
    }

    // --- CUBLAS_EVENTS ---
    if (tableExists(db, 'CUBLAS_EVENTS')) {
      const lane = getOrCreateLane(lanesMap, 'cublas', 'cublas', 'custom');
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT nameId, start, end FROM CUBLAS_EVENTS WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const nameId = row[0] as number;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const apiName = resolveName(nameId);
          const frameIdx = frameTable.getOrInsert({ name: `cublas:${apiName}` });
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;

          const spanId = nextSpanId();
          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: null,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);
        }
      }
    }

    // --- CUDNN_EVENTS ---
    if (tableExists(db, 'CUDNN_EVENTS')) {
      const lane = getOrCreateLane(lanesMap, 'cudnn', 'cudnn', 'custom');
      const filter = timeRangeFilter(options, 'start', 'end');
      const result = db.exec(
        `SELECT nameId, start, end FROM CUDNN_EVENTS WHERE 1=1${filter}`,
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          const nameId = row[0] as number;
          const startNs = row[1] as number;
          const endNs = row[2] as number;
          const apiName = resolveName(nameId);
          const frameIdx = frameTable.getOrInsert({ name: `cudnn:${apiName}` });
          const wallMs = nsToMs(endNs - startNs);

          const v = vals();
          v[V_WALL_MS] = wallMs;

          const spanId = nextSpanId();
          const span: Span = {
            id: spanId,
            frame_index: frameIdx,
            parent_id: null,
            start_time: nsToMs(startNs),
            end_time: nsToMs(endNs),
            values: v,
            args: { start_ns: startNs, end_ns: endNs },
            children: [],
          };
          lane.spans.push(span);
        }
      }
    }

    const lanes = [...lanesMap.values()];

    return {
      format: 'nsight_sqlite',
      profile: {
        id: crypto.randomUUID(),
        name,
        created_at: Date.now(),
        value_types: NSIGHT_VALUE_TYPES,
        categories: [],
        frames: [...frameTable.frames],
        lanes,
        metadata: { source_format: 'nsight_sqlite' },
      },
    };
  } finally {
    db.close();
  }
}
