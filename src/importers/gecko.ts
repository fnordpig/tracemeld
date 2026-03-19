// src/importers/gecko.ts
import type { ImportedProfile } from './types.js';
import type { Sample, Lane, Category } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

interface GeckoThread {
  name: string;
  isMainThread?: boolean;
  pid: number;
  tid: number;
  samples: {
    length: number;
    stack: (number | null)[];
    timeDeltas: number[];
    weight: number[];
  };
  stackTable: { length: number; prefix: (number | null)[]; frame: number[] };
  frameTable: {
    length: number;
    func: number[];
    line: (number | null)[];
    column: (number | null)[];
    category: number[];
  };
  funcTable: {
    length: number;
    name: number[];
    fileName?: (number | null)[];
    lineNumber?: (number | null)[];
    columnNumber?: (number | null)[];
  };
  stringArray: string[];
}

interface GeckoProfile {
  meta: {
    version: number;
    interval: number;
    startTime: number;
    product?: string;
    categories?: Array<{ name: string; color?: string; subcategories?: string[] }>;
  };
  threads: GeckoThread[];
}

export function importGecko(content: string, name: string): ImportedProfile {
  const gecko = JSON.parse(content) as GeckoProfile;
  const frameTable = new FrameTable();
  const lanes: Lane[] = [];
  const categories: Category[] = (gecko.meta.categories ?? []).map((c) => ({
    name: c.name,
    color: c.color,
    subcategories: c.subcategories,
  }));

  for (const thread of gecko.threads) {
    if (thread.samples.length === 0) continue;
    const samples: Sample[] = [];
    let cumulativeTime = 0;

    for (let i = 0; i < thread.samples.length; i++) {
      cumulativeTime += thread.samples.timeDeltas[i] ?? 0;
      const stackIdx = thread.samples.stack[i];
      const stack = resolveStack(thread, frameTable, stackIdx);
      const weight = thread.samples.weight[i] ?? 1;
      samples.push({
        timestamp: gecko.meta.startTime + cumulativeTime,
        stack,
        values: [weight * gecko.meta.interval],
      });
    }

    lanes.push({
      id: `${thread.pid}:${thread.tid}`,
      name: thread.name,
      pid: thread.pid,
      tid: thread.tid,
      kind: thread.isMainThread === true ? 'main' : 'worker',
      samples,
      spans: [],
      markers: [],
    });
  }

  return {
    format: 'gecko',
    profile: {
      id: crypto.randomUUID(),
      name: gecko.meta.product ?? name,
      created_at: gecko.meta.startTime,
      value_types: [{ key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' }],
      categories,
      frames: [...frameTable.frames],
      lanes,
      metadata: { source_format: 'gecko', version: gecko.meta.version },
    },
  };
}

function resolveStack(thread: GeckoThread, frameTable: FrameTable, stackIdx: number | null): number[] {
  const frameIndices: number[] = [];
  let current = stackIdx;
  while (current != null) {
    const frameIdx = thread.stackTable.frame[current];
    const funcIdx = thread.frameTable.func[frameIdx];
    const nameIdx = thread.funcTable.name[funcIdx];
    const funcName = thread.stringArray[nameIdx] ?? `<unknown ${funcIdx}>`;

    const fileNameIdx = thread.funcTable.fileName?.[funcIdx];
    const file = fileNameIdx != null ? (thread.stringArray[fileNameIdx] ?? undefined) : undefined;

    const line = thread.funcTable.lineNumber?.[funcIdx] ?? undefined;
    const col = thread.funcTable.columnNumber?.[funcIdx] ?? undefined;
    const category = thread.frameTable.category[frameIdx];

    frameIndices.push(
      frameTable.getOrInsert({
        name: funcName,
        file,
        line: line ?? undefined,
        col: col ?? undefined,
        category_index: category,
      }),
    );
    current = thread.stackTable.prefix[current];
  }
  frameIndices.reverse();
  return frameIndices;
}
