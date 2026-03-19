// src/importers/collapsed.ts
import type { ImportedProfile } from './types.js';
import { FrameTable } from '../model/frame-table.js';
import type { Sample } from '../model/types.js';

export function importCollapsed(content: string, name: string): ImportedProfile {
  const frameTable = new FrameTable();
  const samples: Sample[] = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace < 0) continue;

    const stackStr = trimmed.substring(0, lastSpace).trim();
    const countStr = trimmed.substring(lastSpace + 1).trim();
    const count = parseInt(countStr, 10);
    if (isNaN(count) || stackStr.length === 0) continue;

    const frameNames = stackStr.split(';');
    const stack: number[] = [];
    for (const frameName of frameNames) {
      stack.push(frameTable.getOrInsert({ name: frameName }));
    }

    samples.push({
      timestamp: null,
      stack,
      values: [count],
    });
  }

  return {
    format: 'collapsed',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: [{ key: 'weight', unit: 'none', description: 'Sample weight/count' }],
      categories: [],
      frames: [...frameTable.frames],
      lanes: [
        {
          id: 'main',
          name: 'main',
          kind: 'main',
          samples,
          spans: [],
          markers: [],
        },
      ],
      metadata: { source_format: 'collapsed' },
    },
  };
}
