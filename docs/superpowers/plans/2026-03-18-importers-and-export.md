# Importers & Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add format auto-detection, collapsed stacks + Chrome trace importers, collapsed stacks exporter, and `import_profile` / `export_profile` MCP tools so external profiling data can be loaded and analyzed, and results can be exported to standard visualization tools.

**Architecture:** Each importer is a pure function `(content: string, name: string) => ImportedProfile` that parses a specific format and produces a partial Profile (frames, lanes with spans/samples). Format detection examines content structure and delegates to the right importer. The `import_profile` tool reads a file, detects format, imports, and merges into the active ProfilerState. The exporter converts the canonical Profile to a text format.

**Tech Stack:** TypeScript 5, MCP SDK, Zod 4, Vitest, pako (for gzip detection).

**Scope note:** Plan 4 of ~5. Covers collapsed stacks + Chrome trace importers, collapsed stacks exporter, and both MCP tools. Gecko, pprof, and speedscope importers + additional exporters can be added incrementally.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/importers/types.ts` | `ImportedProfile` interface, `ImportFormat` type |
| `src/importers/detect.ts` | `detectFormat()` — examines content and returns format hint |
| `src/importers/collapsed.ts` | Collapsed stacks importer (`frame;frame;frame count\n`) |
| `src/importers/chrome-trace.ts` | Chrome Trace Event importer (B/E, X, I, M events) |
| `src/importers/import.ts` | `importProfile()` — orchestrates detection + import + merge into ProfileBuilder |
| `src/exporters/collapsed.ts` | Collapsed stacks exporter |
| `src/server.ts` | Modified — register import_profile and export_profile tools |

Test files: `src/importers/detect.test.ts`, `src/importers/collapsed.test.ts`, `src/importers/chrome-trace.test.ts`, `src/importers/import.test.ts`, `src/exporters/collapsed.test.ts`.

---

### Task 1: Import Types and Format Detection

**Files:**
- Create: `src/importers/types.ts`
- Create: `src/importers/detect.ts`
- Test: `src/importers/detect.test.ts`

- [ ] **Step 1: Write the types (no test needed)**

```typescript
// src/importers/types.ts
import type { Profile } from '../model/types.js';

/** Supported import formats. */
export type ImportFormat = 'collapsed' | 'chrome_trace' | 'gecko' | 'pprof' | 'speedscope' | 'unknown';

/** Result of importing a profile file. Contains a complete Profile ready to merge. */
export interface ImportedProfile {
  format: ImportFormat;
  profile: Profile;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// src/importers/detect.test.ts
import { describe, it, expect } from 'vitest';
import { detectFormat } from './detect.js';

describe('detectFormat', () => {
  it('detects collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    expect(detectFormat(content)).toBe('collapsed');
  });

  it('detects chrome trace with traceEvents wrapper', () => {
    const content = JSON.stringify({ traceEvents: [{ ph: 'X', name: 'test', ts: 0, dur: 100 }] });
    expect(detectFormat(content)).toBe('chrome_trace');
  });

  it('detects chrome trace as raw array', () => {
    const content = JSON.stringify([{ ph: 'X', name: 'test', ts: 0, dur: 100 }]);
    expect(detectFormat(content)).toBe('chrome_trace');
  });

  it('detects gecko profile', () => {
    const content = JSON.stringify({ meta: { version: 24 }, threads: [], libs: [] });
    expect(detectFormat(content)).toBe('gecko');
  });

  it('detects speedscope format', () => {
    const content = JSON.stringify({ '$schema': 'https://www.speedscope.app/file-format-schema.json', shared: {}, profiles: [] });
    expect(detectFormat(content)).toBe('speedscope');
  });

  it('returns unknown for unrecognized content', () => {
    expect(detectFormat('just some random text')).toBe('unknown');
  });

  it('returns unknown for empty content', () => {
    expect(detectFormat('')).toBe('unknown');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/importers/detect.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write the implementation**

```typescript
// src/importers/detect.ts
import type { ImportFormat } from './types.js';

export function detectFormat(content: string): ImportFormat {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'unknown';

  // Try JSON formats first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return detectJsonFormat(parsed as Record<string, unknown>);
      }
      if (Array.isArray(parsed)) {
        return detectArrayFormat(parsed as unknown[]);
      }
    } catch {
      // Not valid JSON, fall through to text formats
    }
  }

  // Check collapsed stacks: lines matching "frame;frame count" or "frame count"
  if (isCollapsedStacks(trimmed)) return 'collapsed';

  return 'unknown';
}

function detectJsonFormat(obj: Record<string, unknown>): ImportFormat {
  // Speedscope
  if (typeof obj['$schema'] === 'string' && (obj['$schema'] as string).includes('speedscope')) {
    return 'speedscope';
  }

  // Chrome trace with traceEvents wrapper
  if ('traceEvents' in obj && Array.isArray(obj['traceEvents'])) {
    return 'chrome_trace';
  }

  // Gecko profile
  if ('meta' in obj && 'threads' in obj && typeof obj['meta'] === 'object' && obj['meta'] !== null) {
    const meta = obj['meta'] as Record<string, unknown>;
    if (typeof meta['version'] === 'number') {
      return 'gecko';
    }
  }

  return 'unknown';
}

function detectArrayFormat(arr: unknown[]): ImportFormat {
  // Chrome trace as raw array of events
  if (arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
    const first = arr[0] as Record<string, unknown>;
    if ('ph' in first) return 'chrome_trace';
  }
  return 'unknown';
}

function isCollapsedStacks(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  // Check first few lines match "frames space/tab number" pattern
  const pattern = /^.+\s+\d+$/;
  const checkCount = Math.min(lines.length, 5);
  let matchCount = 0;
  for (let i = 0; i < checkCount; i++) {
    if (pattern.test(lines[i])) matchCount++;
  }
  // At least 80% of checked lines should match
  return matchCount / checkCount >= 0.8;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/importers/detect.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 6: Lint and commit**

```bash
git add src/importers/types.ts src/importers/detect.ts src/importers/detect.test.ts
git commit -m "feat: add import types and format auto-detection"
```

---

### Task 2: Collapsed Stacks Importer

**Files:**
- Create: `src/importers/collapsed.ts`
- Test: `src/importers/collapsed.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/importers/collapsed.test.ts
import { describe, it, expect } from 'vitest';
import { importCollapsed } from './collapsed.js';

describe('importCollapsed', () => {
  it('parses simple collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');

    expect(result.format).toBe('collapsed');
    expect(result.profile.value_types).toHaveLength(1);
    expect(result.profile.value_types[0].key).toBe('weight');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].name).toBe('main');
  });

  it('creates correct samples', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');
    const samples = result.profile.lanes[0].samples;

    expect(samples).toHaveLength(2);
    expect(samples[0].values).toEqual([10]);
    expect(samples[1].values).toEqual([20]);
    expect(samples[0].timestamp).toBeNull();
  });

  it('deduplicates frames', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');

    // "main" and "foo" appear in both stacks
    // Unique frames: main, foo, bar, baz = 4
    expect(result.profile.frames.length).toBe(4);
  });

  it('builds correct stack indices', () => {
    const content = 'a;b;c 5\n';
    const result = importCollapsed(content, 'test.txt');
    const sample = result.profile.lanes[0].samples[0];

    // Stack should be [idx_a, idx_b, idx_c] bottom to top
    expect(sample.stack).toHaveLength(3);
    expect(result.profile.frames[sample.stack[0]].name).toBe('a');
    expect(result.profile.frames[sample.stack[1]].name).toBe('b');
    expect(result.profile.frames[sample.stack[2]].name).toBe('c');
  });

  it('handles empty lines and whitespace', () => {
    const content = '\n  main;foo 10  \n\n  main;bar 20\n\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.lanes[0].samples).toHaveLength(2);
  });

  it('handles single-frame stacks', () => {
    const content = 'main 100\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.lanes[0].samples).toHaveLength(1);
    expect(result.profile.lanes[0].samples[0].stack).toHaveLength(1);
  });

  it('preserves special characters in frame names', () => {
    const content = 'module`func (file.rs:42) 10\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.frames[0].name).toBe('module`func (file.rs:42)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/importers/collapsed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
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

    // Find the last space — everything before is the stack, after is the count
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace < 0) continue;

    const stackStr = trimmed.substring(0, lastSpace).trim();
    const countStr = trimmed.substring(lastSpace + 1).trim();
    const count = parseInt(countStr, 10);
    if (isNaN(count) || stackStr.length === 0) continue;

    // Split stack by semicolons
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/importers/collapsed.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/importers/collapsed.ts src/importers/collapsed.test.ts
git commit -m "feat: add collapsed stacks importer"
```

---

### Task 3: Chrome Trace Event Importer

**Files:**
- Create: `src/importers/chrome-trace.ts`
- Test: `src/importers/chrome-trace.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/importers/chrome-trace.test.ts
import { describe, it, expect } from 'vitest';
import { importChromeTrace } from './chrome-trace.js';

describe('importChromeTrace', () => {
  it('imports X (complete) events as spans', () => {
    const events = [
      { ph: 'X', name: 'doWork', cat: 'function', ts: 1000, dur: 5000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'inner', cat: 'function', ts: 2000, dur: 1000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.format).toBe('chrome_trace');
    expect(result.profile.lanes.length).toBeGreaterThanOrEqual(1);
    const lane = result.profile.lanes[0];
    expect(lane.spans).toHaveLength(2);
  });

  it('converts timestamps from microseconds to milliseconds', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 1000000, dur: 500000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const span = result.profile.lanes[0].spans[0];

    expect(span.start_time).toBe(1000); // 1000000 µs = 1000 ms
    expect(span.end_time).toBe(1500);   // (1000000 + 500000) µs = 1500 ms
  });

  it('imports B/E event pairs as spans', () => {
    const events = [
      { ph: 'B', name: 'task', ts: 1000, pid: 1, tid: 1 },
      { ph: 'E', name: 'task', ts: 5000, pid: 1, tid: 1 },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes[0].spans).toHaveLength(1);
    const span = result.profile.lanes[0].spans[0];
    expect(span.start_time).toBe(1);  // 1000 µs = 1 ms
    expect(span.end_time).toBe(5);    // 5000 µs = 5 ms
  });

  it('imports instant events as markers', () => {
    const events = [
      { ph: 'i', name: 'GC', ts: 3000, pid: 1, tid: 1, s: 't' },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes[0].markers).toHaveLength(1);
    expect(result.profile.lanes[0].markers[0].name).toBe('GC');
  });

  it('creates separate lanes for different pid+tid', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes).toHaveLength(2);
  });

  it('applies M (metadata) events to lane names', () => {
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'Main Thread' } },
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes[0].name).toBe('Main Thread');
  });

  it('handles raw array format (no traceEvents wrapper)', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify(events);
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes[0].spans).toHaveLength(1);
  });

  it('computes wall_ms values from duration', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 5000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.value_types[0].key).toBe('wall_ms');
    expect(result.profile.lanes[0].spans[0].values[0]).toBe(5); // 5000 µs = 5 ms
  });

  it('preserves args on spans', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: { detail: 'test' } },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');

    expect(result.profile.lanes[0].spans[0].args['detail']).toBe('test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/importers/chrome-trace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/importers/chrome-trace.ts
import type { ImportedProfile } from './types.js';
import type { Span, Marker, Lane } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

interface TraceEvent {
  ph: string;
  name?: string;
  cat?: string;
  ts?: number;
  dur?: number;
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
  const lanesMap = new Map<string, { lane: Lane; openSpans: Map<string, Span> }>();
  let spanIdCounter = 0;

  // First pass: process M (metadata) events to collect lane names
  const laneNames = new Map<string, string>(); // "pid:tid" → name
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args) {
      const key = `${event.pid ?? 0}:${event.tid ?? 0}`;
      laneNames.set(key, String(event.args['name'] ?? key));
    }
    if (event.ph === 'M' && event.name === 'process_name' && event.args) {
      // Process names can be used as fallback
      const processName = String(event.args['name'] ?? '');
      if (processName) {
        // Store with tid=* to use as fallback
        const key = `${event.pid ?? 0}:*`;
        if (!laneNames.has(key)) laneNames.set(key, processName);
      }
    }
  }

  function getOrCreateLane(pid: number, tid: number): { lane: Lane; openSpans: Map<string, Span> } {
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
      entry = { lane, openSpans: new Map() };
      lanesMap.set(key, entry);
    }
    return entry;
  }

  // Second pass: process span and marker events
  for (const event of events) {
    const pid = event.pid ?? 0;
    const tid = event.tid ?? 0;

    switch (event.ph) {
      case 'X': {
        // Complete event
        const { lane } = getOrCreateLane(pid, tid);
        const frameIdx = frameTable.getOrInsert({ name: event.name ?? '<unknown>' });
        const startMs = (event.ts ?? 0) / 1000;
        const durMs = (event.dur ?? 0) / 1000;
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
        // Begin event
        const entry = getOrCreateLane(pid, tid);
        const frameIdx = frameTable.getOrInsert({ name: event.name ?? '<unknown>' });
        const startMs = (event.ts ?? 0) / 1000;
        const span: Span = {
          id: `imp_${spanIdCounter++}`,
          frame_index: frameIdx,
          parent_id: null,
          start_time: startMs,
          end_time: startMs, // Updated on E event
          values: [0],
          args: event.args ?? {},
          children: [],
        };
        entry.lane.spans.push(span);
        entry.openSpans.set(event.name ?? '', span);
        break;
      }

      case 'E': {
        // End event
        const entry = getOrCreateLane(pid, tid);
        const openSpan = entry.openSpans.get(event.name ?? '');
        if (openSpan) {
          const endMs = (event.ts ?? 0) / 1000;
          openSpan.end_time = endMs;
          openSpan.values = [endMs - openSpan.start_time];
          entry.openSpans.delete(event.name ?? '');
        }
        break;
      }

      case 'I':
      case 'i': {
        // Instant event → Marker
        const { lane } = getOrCreateLane(pid, tid);
        lane.markers.push({
          timestamp: (event.ts ?? 0) / 1000,
          name: event.name ?? '<unknown>',
          data: event.args,
        });
        break;
      }

      // M events already processed in first pass
      // C (counter) events skipped for now
    }
  }

  // Build lanes array, marking first as main
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/importers/chrome-trace.test.ts`
Expected: All 9 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/importers/chrome-trace.ts src/importers/chrome-trace.test.ts
git commit -m "feat: add Chrome trace event importer"
```

---

### Task 4: Collapsed Stacks Exporter

**Files:**
- Create: `src/exporters/collapsed.ts`
- Test: `src/exporters/collapsed.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/exporters/collapsed.test.ts
import { describe, it, expect } from 'vitest';
import { exportCollapsed } from './collapsed.js';
import { importCollapsed } from '../importers/collapsed.js';

describe('exportCollapsed', () => {
  it('exports samples as collapsed stacks', () => {
    const input = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);

    expect(output).toContain('main;foo;bar 10');
    expect(output).toContain('main;foo;baz 20');
  });

  it('round-trips collapsed stacks', () => {
    const input = 'a;b;c 5\nx;y 15\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);
    const lines = output.trim().split('\n').sort();
    const expectedLines = input.trim().split('\n').sort();
    expect(lines).toEqual(expectedLines);
  });

  it('exports spans as collapsed stacks using ancestry', () => {
    const profile = importCollapsed('a;b 10\n', 'test.txt').profile;
    // Add a span-based lane
    profile.lanes.push({
      id: 'spans',
      name: 'spans',
      kind: 'worker',
      samples: [],
      spans: [
        {
          id: 's1',
          frame_index: 0, // 'a'
          parent_id: null,
          start_time: 0,
          end_time: 100,
          values: [100],
          args: {},
          children: ['s2'],
        },
        {
          id: 's2',
          frame_index: 1, // 'b'
          parent_id: 's1',
          start_time: 0,
          end_time: 50,
          values: [50],
          args: {},
          children: [],
        },
      ],
      markers: [],
    });
    const output = exportCollapsed(profile);
    expect(output).toContain('a;b 50');
  });

  it('uses first value type as weight by default', () => {
    const input = 'main;foo 10\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);
    expect(output.trim()).toBe('main;foo 10');
  });

  it('returns empty string for empty profile', () => {
    const imported = importCollapsed('', 'test.txt');
    const output = exportCollapsed(imported.profile);
    expect(output.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/exporters/collapsed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/exporters/collapsed.ts
import type { Profile, Span } from '../model/types.js';
import { getSpanAncestry } from '../analysis/query.js';

export function exportCollapsed(profile: Profile, dimensionIndex = 0): string {
  const lines: string[] = [];

  // Export samples
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      const frameNames = sample.stack.map((idx) => profile.frames[idx]?.name ?? '<unknown>');
      const weight = sample.values[dimensionIndex] ?? 0;
      if (frameNames.length > 0 && weight > 0) {
        lines.push(`${frameNames.join(';')} ${weight}`);
      }
    }
  }

  // Export leaf spans (spans with no children) using their ancestry as the stack
  for (const lane of profile.lanes) {
    for (const span of lane.spans) {
      if (span.children.length === 0) {
        const ancestry = getSpanAncestry(profile, span);
        const weight = span.values[dimensionIndex] ?? 0;
        if (ancestry.length > 0 && weight > 0) {
          lines.push(`${ancestry.join(';')} ${weight}`);
        }
      }
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/exporters/collapsed.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/exporters/collapsed.ts src/exporters/collapsed.test.ts
git commit -m "feat: add collapsed stacks exporter"
```

---

### Task 5: import_profile Orchestrator

**Files:**
- Create: `src/importers/import.ts`
- Test: `src/importers/import.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/importers/import.test.ts
import { describe, it, expect } from 'vitest';
import { importProfile } from './import.js';
import { ProfileBuilder } from '../model/profile.js';

describe('importProfile', () => {
  it('auto-detects and imports collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importProfile(content, 'test.txt');
    expect(result.format_detected).toBe('collapsed');
    expect(result.samples_added).toBe(2);
    expect(result.frames_added).toBe(4);
    expect(result.lanes_added).toBe(1);
  });

  it('auto-detects and imports chrome trace', () => {
    const events = [
      { ph: 'X', name: 'doWork', ts: 0, dur: 5000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importProfile(content, 'trace.json');
    expect(result.format_detected).toBe('chrome_trace');
    expect(result.spans_added).toBe(1);
  });

  it('respects format hint', () => {
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt', 'collapsed');
    expect(result.format_detected).toBe('collapsed');
  });

  it('throws on unknown format', () => {
    expect(() => importProfile('random garbage', 'test.txt')).toThrow('unknown');
  });

  it('merges into existing ProfileBuilder', () => {
    const builder = new ProfileBuilder('existing');
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt', 'auto', builder);
    // Should add a new lane to the existing builder
    expect(builder.profile.lanes.length).toBeGreaterThan(1); // main + imported
    expect(result.lanes_added).toBe(1);
  });

  it('returns value_types from imported data', () => {
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt');
    expect(result.value_types).toContain('weight');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/importers/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/importers/import.ts
import type { ImportFormat, ImportedProfile } from './types.js';
import { detectFormat } from './detect.js';
import { importCollapsed } from './collapsed.js';
import { importChromeTrace } from './chrome-trace.js';
import { ProfileBuilder } from '../model/profile.js';

export interface ImportProfileResult {
  format_detected: string;
  lanes_added: number;
  frames_added: number;
  samples_added: number;
  spans_added: number;
  value_types: string[];
}

export function importProfile(
  content: string,
  name: string,
  formatHint: ImportFormat | 'auto' = 'auto',
  mergeInto?: ProfileBuilder,
): ImportProfileResult {
  const format = formatHint === 'auto' ? detectFormat(content) : formatHint;

  if (format === 'unknown') {
    throw new Error(`Unable to detect format for '${name}'. Format is unknown.`);
  }

  const imported = runImporter(content, name, format);

  // Count what we imported
  let samplesAdded = 0;
  let spansAdded = 0;
  for (const lane of imported.profile.lanes) {
    samplesAdded += lane.samples.length;
    spansAdded += lane.spans.length;
  }

  const framesAdded = imported.profile.frames.length;
  const lanesAdded = imported.profile.lanes.length;
  const valueTypes = imported.profile.value_types.map((vt) => vt.key);

  // Merge into existing builder if provided
  if (mergeInto) {
    mergeImportedProfile(mergeInto, imported);
  }

  return {
    format_detected: format,
    lanes_added: lanesAdded,
    frames_added: framesAdded,
    samples_added: samplesAdded,
    spans_added: spansAdded,
    value_types: valueTypes,
  };
}

function runImporter(content: string, name: string, format: ImportFormat): ImportedProfile {
  switch (format) {
    case 'collapsed':
      return importCollapsed(content, name);
    case 'chrome_trace':
      return importChromeTrace(content, name);
    case 'gecko':
    case 'pprof':
    case 'speedscope':
      throw new Error(`Format '${format}' is not yet implemented`);
    default:
      throw new Error(`Unknown format: ${String(format)}`);
  }
}

function mergeImportedProfile(builder: ProfileBuilder, imported: ImportedProfile): void {
  // Re-map frame indices from imported profile to the builder's frame table
  const frameIndexMap = new Map<number, number>();
  for (let i = 0; i < imported.profile.frames.length; i++) {
    const newIdx = builder.frameTable.getOrInsert(imported.profile.frames[i]);
    frameIndexMap.set(i, newIdx);
  }

  // Add lanes with remapped frame indices
  for (const lane of imported.profile.lanes) {
    const newLane = builder.addLane(`imported:${lane.id}`, lane.kind);
    newLane.name = lane.name;
    newLane.pid = lane.pid;
    newLane.tid = lane.tid;

    for (const sample of lane.samples) {
      newLane.samples.push({
        ...sample,
        stack: sample.stack.map((idx) => frameIndexMap.get(idx) ?? idx),
      });
    }

    for (const span of lane.spans) {
      newLane.spans.push({
        ...span,
        frame_index: frameIndexMap.get(span.frame_index) ?? span.frame_index,
      });
    }

    for (const marker of lane.markers) {
      newLane.markers.push({ ...marker });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/importers/import.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/importers/import.ts src/importers/import.test.ts
git commit -m "feat: add import_profile orchestrator with format detection"
```

---

### Task 6: Wire import_profile and export_profile into MCP Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add integration tests**

Read the current `src/server.test.ts`, then append inside the existing `describe` block:

```typescript
it('import_profile imports collapsed stacks', async () => {
  const c = await createTestClient();
  const result = await c.callTool({
    name: 'import_profile',
    arguments: { source: 'main;foo;bar 10\nmain;foo;baz 20\n' },
  });
  const parsed = parseToolResult(result) as { format_detected: string; samples_added: number };
  expect(parsed.format_detected).toBe('collapsed');
  expect(parsed.samples_added).toBe(2);
});

it('export_profile exports collapsed stacks', async () => {
  const c = await createTestClient();
  // Import some data first
  await c.callTool({
    name: 'import_profile',
    arguments: { source: 'main;foo;bar 10\n' },
  });
  const result = await c.callTool({
    name: 'export_profile',
    arguments: { format: 'collapsed' },
  });
  const parsed = parseToolResult(result) as { data: string; size_bytes: number };
  expect(parsed.data).toContain('main;foo;bar 10');
  expect(parsed.size_bytes).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Register tools in server.ts**

Read current `src/server.ts`. Add imports:

```typescript
import { importProfile } from './importers/import.js';
import { exportCollapsed } from './exporters/collapsed.js';
import { readFileSync, existsSync } from 'node:fs';
```

Add import_profile tool registration:

```typescript
server.registerTool(
  'import_profile',
  {
    description:
      "Load profiling data from a file path or inline string. Auto-detects format (collapsed stacks, Chrome trace) or accepts a hint. Use when you want to analyze an existing profile.",
    inputSchema: {
      source: z.string().describe('File path or inline profile data string'),
      format: z.enum(['auto', 'collapsed', 'chrome_trace', 'gecko', 'pprof', 'speedscope']).optional(),
      lane_name: z.string().optional(),
    },
  },
  (args) => {
    let content: string;
    // Try reading as file path first
    if (!args.source.includes('\n') && existsSync(args.source)) {
      content = readFileSync(args.source, 'utf-8');
    } else {
      content = args.source;
    }
    const result = importProfile(
      content,
      args.lane_name ?? 'imported',
      (args.format ?? 'auto') as 'auto' | 'collapsed' | 'chrome_trace' | 'gecko' | 'pprof' | 'speedscope',
      state.builder,
    );
    state.invalidatePatternCache();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
```

Add export_profile tool registration:

```typescript
server.registerTool(
  'export_profile',
  {
    description:
      "Export the current profile to a standard format for visualization. Currently supports 'collapsed' (for flamegraph tools). Returns the data as a string.",
    inputSchema: {
      format: z.enum(['collapsed']).describe('Export format'),
      output_path: z.string().optional().describe('File path to write. If omitted, returns data inline.'),
    },
  },
  (args) => {
    let data: string;
    if (args.format === 'collapsed') {
      data = exportCollapsed(state.builder.profile);
    } else {
      throw new Error(`Unsupported export format: ${String(args.format)}`);
    }

    if (args.output_path) {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(args.output_path, data, 'utf-8');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            format: args.format,
            file_path: args.output_path,
            size_bytes: Buffer.byteLength(data, 'utf-8'),
            notes: [],
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          format: args.format,
          data,
          size_bytes: Buffer.byteLength(data, 'utf-8'),
          notes: [],
        }),
      }],
    };
  },
);
```

NOTE: The `require` for writeFileSync inside the conditional is to avoid importing it unconditionally. Alternatively, use a top-level `import { writeFileSync } from 'node:fs'` and add it to the existing fs import. The implementer should choose the cleaner approach — a single top-level import is preferred:

```typescript
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
```

Then use `writeFileSync` directly in the handler.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/`

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: wire import_profile and export_profile into MCP server"
```

---

## Summary

After completing all 6 tasks, tracemeld will have:

- **Format auto-detection** — examines content structure to identify collapsed stacks, Chrome trace, Gecko, speedscope
- **Collapsed stacks importer** — `frame;frame;frame count` text format
- **Chrome trace event importer** — X, B/E, I/i, M events with multi-lane support
- **Collapsed stacks exporter** — round-trips samples and exports leaf spans as stacks
- **import_profile MCP tool** — reads files or inline strings, auto-detects, merges into session
- **export_profile MCP tool** — exports current profile to collapsed stacks format
- **8 MCP tools total** — trace, mark, profile_summary, hotspots, explain_span, find_waste, import_profile, export_profile

Gecko, pprof, and speedscope importers + additional export formats can be added incrementally.

**Next plan:** Remaining tools (token_flow, compare) + MCP prompts.
