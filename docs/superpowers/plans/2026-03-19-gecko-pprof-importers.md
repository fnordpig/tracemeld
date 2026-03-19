# Gecko & pprof Importers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gecko Profiler (samply/Firefox Profiler v24+) and pprof (Go CPU profiles) importers so tracemeld can analyze native performance traces.

**Architecture:** Each importer is a pure function `(content: string, name: string) => ImportedProfile`. The Gecko importer reconstructs stacks from the columnar prefix-tree format (`stackTable.prefix[]` / `stackTable.frame[]` → `frameTable.func[]` → `funcTable.name[]` → `stringArray[]`). The pprof importer manually decodes the protobuf wire format (no protobuf library) since the schema is small and stable. Both are wired into the existing `runImporter` switch in `import.ts`.

**Tech Stack:** TypeScript 5, Vitest, pako (gzip decompression for pprof).

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/importers/gecko.ts` | Gecko Profiler v24+ importer (columnar format with stringArray) |
| `src/importers/pprof.ts` | pprof protobuf importer (manual wire format decoding) |
| `src/importers/import.ts` | Modified — wire gecko and pprof into runImporter switch |
| `src/importers/detect.ts` | Modified — add gzip/pprof detection for binary content |
| `fixtures/gecko/simple.json` | Minimal Gecko test fixture |
| `fixtures/collapsed/simple.txt` | Minimal collapsed stacks fixture (already have tests inline) |

---

### Task 1: Gecko Profiler Importer

**Files:**
- Create: `src/importers/gecko.ts`
- Test: `src/importers/gecko.test.ts`
- Create: `fixtures/gecko/simple.json`

- [ ] **Step 1: Create a minimal Gecko test fixture**

```json
{
  "meta": {
    "version": 24,
    "interval": 1,
    "startTime": 1000000,
    "product": "test-app",
    "categories": [
      { "name": "Other", "color": "grey", "subcategories": ["Other"] },
      { "name": "User", "color": "yellow", "subcategories": ["Other"] }
    ]
  },
  "libs": [],
  "threads": [
    {
      "name": "main",
      "isMainThread": true,
      "pid": 1,
      "tid": 1,
      "registerTime": 0,
      "unregisterTime": null,
      "processType": "default",
      "processName": "test-app",
      "processStartupTime": 0,
      "processShutdownTime": null,
      "pausedRanges": [],
      "showMarkersInTimeline": false,
      "samples": {
        "length": 4,
        "weightType": "samples",
        "stack": [2, 4, 4, 2],
        "timeDeltas": [0, 1, 1, 1],
        "weight": [1, 1, 1, 1],
        "threadCPUDelta": [0, 0, 0, 0]
      },
      "stackTable": {
        "length": 5,
        "prefix": [null, 0, 1, 0, 3],
        "frame": [0, 1, 2, 1, 3]
      },
      "frameTable": {
        "length": 4,
        "address": [-1, -1, -1, -1],
        "inlineDepth": [0, 0, 0, 0],
        "category": [1, 1, 1, 1],
        "subcategory": [0, 0, 0, 0],
        "func": [0, 1, 2, 3],
        "nativeSymbol": [null, null, null, null],
        "innerWindowID": [0, 0, 0, 0],
        "line": [null, null, null, null],
        "column": [null, null, null, null]
      },
      "funcTable": {
        "length": 4,
        "name": [0, 1, 2, 3],
        "isJS": [false, false, false, false],
        "relevantForJS": [false, false, false, false],
        "resource": [-1, -1, -1, -1],
        "fileName": [null, null, null, null],
        "lineNumber": [null, null, null, null],
        "columnNumber": [null, null, null, null]
      },
      "stringArray": ["main", "doWork", "compute", "render"],
      "resourceTable": { "length": 0, "lib": [], "name": [], "host": [], "type": [] },
      "markers": { "length": 0, "category": [], "data": [], "endTime": [], "name": [], "phase": [], "startTime": [] },
      "nativeSymbols": { "length": 0, "address": [], "functionSize": [], "libIndex": [], "name": [] }
    }
  ],
  "pages": [],
  "profilerOverhead": [],
  "counters": []
}
```

Save to `fixtures/gecko/simple.json`.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/importers/gecko.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importGecko } from './gecko.js';

describe('importGecko', () => {
  function loadFixture(): string {
    return readFileSync('fixtures/gecko/simple.json', 'utf-8');
  }

  it('imports a gecko profile', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.format).toBe('gecko');
    expect(result.profile.lanes.length).toBeGreaterThanOrEqual(1);
    expect(result.profile.lanes[0].name).toBe('main');
  });

  it('creates samples from the samples table', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const lane = result.profile.lanes[0];
    expect(lane.samples.length).toBe(4);
  });

  it('resolves function names through the chain', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const frameNames = result.profile.frames.map((f) => f.name);
    expect(frameNames).toContain('main');
    expect(frameNames).toContain('doWork');
    expect(frameNames).toContain('compute');
    expect(frameNames).toContain('render');
  });

  it('builds correct stack from prefix tree', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const lane = result.profile.lanes[0];
    // Sample 0 has stack index 2: prefix tree is 2→1→0
    // stack[2].frame=2 (compute), stack[1].frame=1 (doWork), stack[0].frame=0 (main)
    // So bottom-to-top: [main, doWork, compute]
    const sample0 = lane.samples[0];
    const stack0Names = sample0.stack.map((idx) => result.profile.frames[idx].name);
    expect(stack0Names).toEqual(['main', 'doWork', 'compute']);
  });

  it('uses wall_ms as the value type', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.value_types[0].key).toBe('wall_ms');
  });

  it('imports categories from meta', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.categories.length).toBe(2);
    expect(result.profile.categories[0].name).toBe('Other');
  });

  it('sets profile name from meta.product', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.name).toBe('test-app');
  });

  it('marks the main thread lane as main kind', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const mainLane = result.profile.lanes.find((l) => l.name === 'main');
    expect(mainLane?.kind).toBe('main');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/importers/gecko.test.ts`

- [ ] **Step 4: Write the implementation**

```typescript
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
  stackTable: {
    length: number;
    prefix: (number | null)[];
    frame: number[];
  };
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

  // Import categories
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
      cumulativeTime += thread.samples.timeDeltas[i];
      const stackIdx = thread.samples.stack[i];
      const stack = resolveStack(thread, frameTable, stackIdx);
      const weight = thread.samples.weight[i] ?? 1;

      samples.push({
        timestamp: gecko.meta.startTime + cumulativeTime,
        stack,
        values: [weight * gecko.meta.interval], // Convert sample count to ms using interval
      });
    }

    lanes.push({
      id: `${thread.pid}:${thread.tid}`,
      name: thread.name,
      pid: thread.pid,
      tid: thread.tid,
      kind: thread.isMainThread ? 'main' : 'worker',
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

function resolveStack(
  thread: GeckoThread,
  frameTable: FrameTable,
  stackIdx: number | null,
): number[] {
  const frameIndices: number[] = [];

  while (stackIdx != null) {
    const frameIdx = thread.stackTable.frame[stackIdx];
    const funcIdx = thread.frameTable.func[frameIdx];
    const nameIdx = thread.funcTable.name[funcIdx];
    const funcName = thread.stringArray[nameIdx] ?? `<unknown ${funcIdx}>`;

    const file = thread.funcTable.fileName?.[funcIdx] != null
      ? thread.stringArray[thread.funcTable.fileName[funcIdx]!]
      : undefined;
    const line = thread.funcTable.lineNumber?.[funcIdx] ?? undefined;
    const col = thread.funcTable.columnNumber?.[funcIdx] ?? undefined;
    const category = thread.frameTable.category[frameIdx];

    const idx = frameTable.getOrInsert({
      name: funcName,
      file: file ?? undefined,
      line: line ?? undefined,
      col: col ?? undefined,
      category_index: category,
    });

    frameIndices.push(idx);
    stackIdx = thread.stackTable.prefix[stackIdx];
  }

  frameIndices.reverse(); // Bottom (root) to top (leaf)
  return frameIndices;
}
```

NOTE: The `thread.funcTable.fileName[funcIdx]!` non-null assertion is inside a null check guard (`!= null`). ESLint may still flag it — replace with:
```typescript
const fileIdx = thread.funcTable.fileName?.[funcIdx];
const file = fileIdx != null ? thread.stringArray[fileIdx] : undefined;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/importers/gecko.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 6: Lint and commit**

```bash
git add src/importers/gecko.ts src/importers/gecko.test.ts fixtures/gecko/simple.json
git commit -m "feat: add Gecko Profiler importer"
```

---

### Task 2: pprof Importer

**Files:**
- Create: `src/importers/pprof.ts`
- Test: `src/importers/pprof.test.ts`
- Create: `fixtures/pprof/simple.pb.gz`

The pprof format is gzip-compressed protobuf. We'll manually decode the wire format since the schema is small. The key message types are:

- `Profile` (field 1: sample_type[], field 2: sample[], field 3: mapping[], field 4: location[], field 5: function[], field 6: string_table[])
- `Sample` (field 1: location_id[], field 2: value[], field 3: label[])
- `ValueType` (field 1: type (int64, string table index), field 2: unit (int64, string table index))
- `Location` (field 1: id, field 4: line[])
- `Line` (field 1: function_id, field 2: line)
- `Function` (field 1: id, field 2: name (string table index), field 4: filename (string table index))

- [ ] **Step 1: Create a test fixture**

We'll generate a minimal pprof fixture programmatically in the test rather than shipping a binary file. This avoids binary fixtures in the repo.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/importers/pprof.test.ts
import { describe, it, expect } from 'vitest';
import pako from 'pako';
import { importPprof } from './pprof.js';

// Build a minimal pprof protobuf by hand
function buildMinimalPprof(): Uint8Array {
  // We'll use a simpler approach: build the pprof as a JSON-like structure
  // then encode it. But since we're testing the decoder, we need actual protobuf bytes.
  // Instead, test with the higher-level importPprofFromBuffer which takes raw bytes.
  // For now, use a known-good minimal encoding.

  // String table: ["", "samples", "count", "cpu", "nanoseconds", "main", "doWork", "compute", "main.go", "work.go"]
  // sample_type: [{type: 1 ("samples"), unit: 2 ("count")}, {type: 3 ("cpu"), unit: 4 ("nanoseconds")}]
  // function: [{id:1, name:5 ("main"), filename:8 ("main.go")}, {id:2, name:6 ("doWork"), filename:9 ("work.go")}, {id:3, name:7 ("compute"), filename:9}]
  // location: [{id:1, line:[{function_id:1, line:10}]}, {id:2, line:[{function_id:2, line:20}]}, {id:3, line:[{function_id:3, line:30}]}]
  // sample: [{location_id:[3,2,1], value:[1, 10000000]}]

  // This is complex to encode manually. Let's test with a pre-built buffer.
  // We'll encode a minimal valid protobuf using our own encoder helper.
  return buildProtobuf();
}

function buildProtobuf(): Uint8Array {
  const buf: number[] = [];

  function writeVarint(value: number): void {
    let v = value;
    while (v > 0x7f) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v & 0x7f);
  }

  function writeTag(field: number, wireType: number): void {
    writeVarint((field << 3) | wireType);
  }

  function writeBytes(field: number, data: Uint8Array): void {
    writeTag(field, 2); // length-delimited
    writeVarint(data.length);
    for (const b of data) buf.push(b);
  }

  function writeString(field: number, str: string): void {
    const encoded = new TextEncoder().encode(str);
    writeBytes(field, encoded);
  }

  function writeVarintField(field: number, value: number): void {
    writeTag(field, 0);
    writeVarint(value);
  }

  // Build submessages
  function encodeMessage(fn: () => void): Uint8Array {
    const outer = buf.length;
    const saved = buf.splice(0, buf.length);
    fn();
    const inner = new Uint8Array(buf.splice(0, buf.length));
    buf.push(...saved);
    return inner;
  }

  // String table (field 6, repeated string)
  const strings = ['', 'samples', 'count', 'cpu', 'nanoseconds', 'main', 'doWork', 'compute', 'main.go', 'work.go'];
  for (const s of strings) {
    writeString(6, s);
  }

  // sample_type (field 1, repeated ValueType message)
  const st1 = encodeMessage(() => { writeVarintField(1, 1); writeVarintField(2, 2); });
  writeBytes(1, st1);
  const st2 = encodeMessage(() => { writeVarintField(1, 3); writeVarintField(2, 4); });
  writeBytes(1, st2);

  // function (field 5, repeated Function message)
  const fn1 = encodeMessage(() => { writeVarintField(1, 1); writeVarintField(2, 5); writeVarintField(4, 8); });
  writeBytes(5, fn1);
  const fn2 = encodeMessage(() => { writeVarintField(1, 2); writeVarintField(2, 6); writeVarintField(4, 9); });
  writeBytes(5, fn2);
  const fn3 = encodeMessage(() => { writeVarintField(1, 3); writeVarintField(2, 7); writeVarintField(4, 9); });
  writeBytes(5, fn3);

  // location (field 4, repeated Location message)
  const line1 = encodeMessage(() => { writeVarintField(1, 1); writeVarintField(2, 10); });
  const loc1 = encodeMessage(() => { writeVarintField(1, 1); writeBytes(4, line1); });
  writeBytes(4, loc1);
  const line2 = encodeMessage(() => { writeVarintField(1, 2); writeVarintField(2, 20); });
  const loc2 = encodeMessage(() => { writeVarintField(1, 2); writeBytes(4, line2); });
  writeBytes(4, loc2);
  const line3 = encodeMessage(() => { writeVarintField(1, 3); writeVarintField(2, 30); });
  const loc3 = encodeMessage(() => { writeVarintField(1, 3); writeBytes(4, line3); });
  writeBytes(4, loc3);

  // sample (field 2, repeated Sample message)
  // location_id: [3, 2, 1] (leaf to root), value: [1, 10000000]
  const samp = encodeMessage(() => {
    writeVarintField(1, 3);
    writeVarintField(1, 2);
    writeVarintField(1, 1);
    writeVarintField(2, 1);
    writeVarintField(2, 10000000);
  });
  writeBytes(2, samp);

  return new Uint8Array(buf);
}

describe('importPprof', () => {
  it('imports a pprof profile from gzipped protobuf', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');

    expect(result.format).toBe('pprof');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].samples.length).toBeGreaterThan(0);
  });

  it('resolves function names from string table', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');

    const frameNames = result.profile.frames.map((f) => f.name);
    expect(frameNames).toContain('main');
    expect(frameNames).toContain('doWork');
    expect(frameNames).toContain('compute');
  });

  it('extracts value types from sample_type', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');

    expect(result.profile.value_types).toHaveLength(2);
    expect(result.profile.value_types[0].key).toBe('samples');
    expect(result.profile.value_types[1].key).toBe('cpu');
  });

  it('builds correct stack order (root to leaf)', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');

    const sample = result.profile.lanes[0].samples[0];
    const stackNames = sample.stack.map((idx) => result.profile.frames[idx].name);
    // pprof location_ids are leaf-to-root [3,2,1] = [compute, doWork, main]
    // We reverse to root-to-leaf: [main, doWork, compute]
    expect(stackNames).toEqual(['main', 'doWork', 'compute']);
  });

  it('extracts file and line from functions', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');

    const mainFrame = result.profile.frames.find((f) => f.name === 'main');
    expect(mainFrame?.file).toBe('main.go');
    expect(mainFrame?.line).toBe(10);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/importers/pprof.test.ts`

- [ ] **Step 4: Write the implementation**

```typescript
// src/importers/pprof.ts
import type { ImportedProfile } from './types.js';
import type { Sample } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';
import pako from 'pako';

// Protobuf wire format decoder
interface PprofProfile {
  stringTable: string[];
  sampleTypes: Array<{ type: number; unit: number }>;
  samples: Array<{ locationIds: number[]; values: number[] }>;
  locations: Map<number, { lines: Array<{ functionId: number; line: number }> }>;
  functions: Map<number, { name: number; filename: number }>;
}

export function importPprof(content: string, name: string): ImportedProfile {
  // Decompress gzip
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i);
  }

  let decompressed: Uint8Array;
  try {
    decompressed = pako.ungzip(bytes);
  } catch {
    // Try as raw protobuf
    decompressed = bytes;
  }

  const pprof = decodeProfile(decompressed);
  const frameTable = new FrameTable();
  const samples: Sample[] = [];

  // Build value types
  const valueTypes = pprof.sampleTypes.map((st) => ({
    key: pprof.stringTable[st.type] ?? 'unknown',
    unit: mapPprofUnit(pprof.stringTable[st.unit] ?? ''),
    description: `${pprof.stringTable[st.type] ?? ''} (${pprof.stringTable[st.unit] ?? ''})`,
  }));

  // Build samples
  for (const sample of pprof.samples) {
    // location_ids are leaf-to-root, we need root-to-leaf
    const stack: number[] = [];
    for (let i = sample.locationIds.length - 1; i >= 0; i--) {
      const loc = pprof.locations.get(sample.locationIds[i]);
      if (!loc) continue;
      for (const line of loc.lines) {
        const func = pprof.functions.get(line.functionId);
        if (!func) continue;
        const funcName = pprof.stringTable[func.name] ?? '<unknown>';
        const fileName = pprof.stringTable[func.filename] || undefined;
        stack.push(frameTable.getOrInsert({
          name: funcName,
          file: fileName,
          line: line.line || undefined,
        }));
      }
    }

    samples.push({
      timestamp: null,
      stack,
      values: sample.values,
    });
  }

  return {
    format: 'pprof',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: valueTypes,
      categories: [],
      frames: [...frameTable.frames],
      lanes: [{
        id: 'main',
        name: 'main',
        kind: 'main',
        samples,
        spans: [],
        markers: [],
      }],
      metadata: { source_format: 'pprof' },
    },
  };
}

function mapPprofUnit(unit: string): 'nanoseconds' | 'microseconds' | 'milliseconds' | 'seconds' | 'bytes' | 'none' {
  switch (unit) {
    case 'nanoseconds': return 'nanoseconds';
    case 'microseconds': return 'microseconds';
    case 'milliseconds': return 'milliseconds';
    case 'seconds': return 'seconds';
    case 'bytes': return 'bytes';
    default: return 'none';
  }
}

// --- Protobuf wire format decoder ---

function decodeProfile(data: Uint8Array): PprofProfile {
  const result: PprofProfile = {
    stringTable: [],
    sampleTypes: [],
    samples: [],
    locations: new Map(),
    functions: new Map(),
  };

  const reader = new ProtoReader(data);
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: { // sample_type
        const sub = reader.readSubMessage();
        result.sampleTypes.push(decodeSampleType(sub));
        break;
      }
      case 2: { // sample
        const sub = reader.readSubMessage();
        result.samples.push(decodeSample(sub));
        break;
      }
      case 4: { // location
        const sub = reader.readSubMessage();
        const loc = decodeLocation(sub);
        result.locations.set(loc.id, { lines: loc.lines });
        break;
      }
      case 5: { // function
        const sub = reader.readSubMessage();
        const fn = decodeFunction(sub);
        result.functions.set(fn.id, { name: fn.name, filename: fn.filename });
        break;
      }
      case 6: { // string_table
        result.stringTable.push(reader.readString(wireType));
        break;
      }
      default:
        reader.skip(wireType);
    }
  }

  return result;
}

function decodeSampleType(reader: ProtoReader): { type: number; unit: number } {
  let type = 0;
  let unit = 0;
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: type = reader.readVarint(); break;
      case 2: unit = reader.readVarint(); break;
      default: reader.skip(wireType);
    }
  }
  return { type, unit };
}

function decodeSample(reader: ProtoReader): { locationIds: number[]; values: number[] } {
  const locationIds: number[] = [];
  const values: number[] = [];
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: locationIds.push(reader.readVarint()); break;
      case 2: values.push(reader.readVarint()); break;
      default: reader.skip(wireType);
    }
  }
  return { locationIds, values };
}

function decodeLocation(reader: ProtoReader): { id: number; lines: Array<{ functionId: number; line: number }> } {
  let id = 0;
  const lines: Array<{ functionId: number; line: number }> = [];
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: id = reader.readVarint(); break;
      case 4: {
        const sub = reader.readSubMessage();
        lines.push(decodeLine(sub));
        break;
      }
      default: reader.skip(wireType);
    }
  }
  return { id, lines };
}

function decodeLine(reader: ProtoReader): { functionId: number; line: number } {
  let functionId = 0;
  let line = 0;
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: functionId = reader.readVarint(); break;
      case 2: line = reader.readVarint(); break;
      default: reader.skip(wireType);
    }
  }
  return { functionId, line };
}

function decodeFunction(reader: ProtoReader): { id: number; name: number; filename: number } {
  let id = 0;
  let name = 0;
  let filename = 0;
  while (reader.hasMore()) {
    const [field, wireType] = reader.readTag();
    switch (field) {
      case 1: id = reader.readVarint(); break;
      case 2: name = reader.readVarint(); break;
      case 4: filename = reader.readVarint(); break;
      default: reader.skip(wireType);
    }
  }
  return { id, name, filename };
}

class ProtoReader {
  private pos = 0;
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  hasMore(): boolean {
    return this.pos < this.data.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0; // unsigned
  }

  readTag(): [number, number] {
    const v = this.readVarint();
    return [v >>> 3, v & 0x7];
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const result = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return result;
  }

  readString(wireType: number): string {
    if (wireType === 2) {
      const bytes = this.readBytes();
      return new TextDecoder().decode(bytes);
    }
    return '';
  }

  readSubMessage(): ProtoReader {
    return new ProtoReader(this.readBytes());
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.readVarint(); break;
      case 1: this.pos += 8; break; // 64-bit
      case 2: { const len = this.readVarint(); this.pos += len; break; }
      case 5: this.pos += 4; break; // 32-bit
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/importers/pprof.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 6: Lint and commit**

```bash
git add src/importers/pprof.ts src/importers/pprof.test.ts
git commit -m "feat: add pprof protobuf importer"
```

---

### Task 3: Wire Gecko and pprof into Import Pipeline

**Files:**
- Modify: `src/importers/import.ts` — add gecko and pprof to runImporter switch
- Modify: `src/importers/detect.ts` — update to handle binary/gzip detection for pprof
- Test: `src/importers/import.test.ts` — add tests for gecko and pprof via importProfile

- [ ] **Step 1: Add integration tests**

Append to existing `src/importers/import.test.ts`:

```typescript
it('auto-detects and imports gecko profile', () => {
  const content = readFileSync('fixtures/gecko/simple.json', 'utf-8');
  const result = importProfile(content, 'gecko-profile.json');
  expect(result.format_detected).toBe('gecko');
  expect(result.samples_added).toBeGreaterThan(0);
});

it('imports pprof with format hint', () => {
  // Build minimal pprof
  const raw = buildMinimalPprof();
  const gzipped = pako.gzip(raw);
  const content = Buffer.from(gzipped).toString('binary');
  const result = importProfile(content, 'cpu.pb.gz', 'pprof');
  expect(result.format_detected).toBe('pprof');
  expect(result.samples_added).toBeGreaterThan(0);
});
```

Add needed imports at top of import.test.ts:
```typescript
import { readFileSync } from 'node:fs';
import pako from 'pako';
```

Also add the `buildMinimalPprof` helper (copy from pprof.test.ts or factor into a shared fixture helper).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Update import.ts**

In `runImporter`, replace the gecko/pprof throw cases:

```typescript
case 'gecko':
  return importGecko(content, name);
case 'pprof':
  return importPprof(content, name);
```

Add imports:
```typescript
import { importGecko } from './gecko.js';
import { importPprof } from './pprof.js';
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Lint and commit**

```bash
git add src/importers/import.ts src/importers/import.test.ts
git commit -m "feat: wire gecko and pprof importers into import pipeline"
```

---

## Summary

After completing all 3 tasks:

- **Gecko Profiler importer** — handles samply/Firefox Profiler v24+ columnar format (stackTable prefix-tree → frameTable → funcTable → stringArray)
- **pprof importer** — manual protobuf wire format decoder, handles gzip-compressed profiles from Go, Rust (via pprof-rs), Python (via py-spy)
- **Both wired into import pipeline** — auto-detection for gecko (JSON with meta.version + threads), format hint for pprof (binary detection is format-hint based for now)

4 importers total: collapsed stacks, Chrome trace, Gecko, pprof.
