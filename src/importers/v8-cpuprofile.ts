// src/importers/v8-cpuprofile.ts
import type { ImportedProfile } from './types.js';
import type { Sample } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

/**
 * V8 CPUProfile format — produced by `node --cpu-prof` and Chrome DevTools.
 * Structure: a tree of nodes (each with a callFrame), plus parallel
 * `samples` (node IDs) and `timeDeltas` (microseconds between samples).
 */

interface V8CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface V8Node {
  id: number;
  callFrame: V8CallFrame;
  hitCount: number;
  children?: number[];
}

interface V8CpuProfile {
  nodes: V8Node[];
  startTime: number; // microseconds
  endTime: number; // microseconds
  samples: number[]; // node IDs
  timeDeltas: number[]; // microseconds between samples
}

export function importV8CpuProfile(content: string, name: string): ImportedProfile {
  const parsed = JSON.parse(content) as V8CpuProfile;

  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.samples)) {
    throw new Error('Invalid V8 CPUProfile: missing nodes or samples arrays');
  }

  const frameTable = new FrameTable();

  // Build node ID → node lookup and parent map
  const nodeById = new Map<number, V8Node>();
  const parentOf = new Map<number, number>(); // child id → parent id
  for (const node of parsed.nodes) {
    nodeById.set(node.id, node);
    if (node.children) {
      for (const childId of node.children) {
        parentOf.set(childId, node.id);
      }
    }
  }

  // Build node ID → frame index, mapping V8 callFrames to our Frame type
  const nodeFrameIndex = new Map<number, number>();
  for (const node of parsed.nodes) {
    const cf = node.callFrame;
    const frameName = cf.functionName || '(anonymous)';
    const file = cf.url || undefined;
    const line = cf.lineNumber >= 0 ? cf.lineNumber + 1 : undefined; // V8 uses 0-based
    const col = cf.columnNumber >= 0 ? cf.columnNumber + 1 : undefined;
    const idx = frameTable.getOrInsert({ name: frameName, file, line, col });
    nodeFrameIndex.set(node.id, idx);
  }

  // Walk from a sample node up to root to reconstruct the stack (root-first)
  function buildStack(nodeId: number): number[] {
    const stack: number[] = [];
    let current: number | undefined = nodeId;
    while (current !== undefined) {
      const frameIdx = nodeFrameIndex.get(current);
      if (frameIdx !== undefined) {
        stack.push(frameIdx);
      }
      current = parentOf.get(current);
    }
    stack.reverse(); // root first
    return stack;
  }

  // Convert samples + timeDeltas into Sample objects
  const startTimeMs = parsed.startTime / 1000;
  const samples: Sample[] = [];
  let cumulativeUs = 0;

  for (let i = 0; i < parsed.samples.length; i++) {
    const delta = i < parsed.timeDeltas.length ? parsed.timeDeltas[i] : 0;
    cumulativeUs += delta;
    const timestampMs = startTimeMs + cumulativeUs / 1000;
    const stack = buildStack(parsed.samples[i]);
    const weightMs = delta / 1000;
    samples.push({
      timestamp: timestampMs,
      stack,
      values: [weightMs],
    });
  }

  const durationMs = (parsed.endTime - parsed.startTime) / 1000;

  return {
    format: 'v8_cpuprofile',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: [{ key: 'cpu_ms', unit: 'milliseconds', description: 'CPU sample weight' }],
      categories: [],
      frames: [...frameTable.frames],
      lanes: [
        {
          id: 'main',
          name: name,
          kind: 'main',
          samples,
          spans: [],
          markers: [],
        },
      ],
      metadata: {
        source_format: 'v8_cpuprofile',
        duration_ms: durationMs,
        sample_count: parsed.samples.length,
      },
    },
  };
}
