# CUDA Profiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import NVIDIA Nsight Systems SQLite profiles into tracemeld's canonical model so existing analysis tools work on GPU data.

**Architecture:** Nsight SQLite importer (async, uses sql.js WASM) handled as a special case in the `import_profile` tool handler before string decode. All other importers unchanged. Skill teaches agents how to capture and analyze CUDA profiles.

**Tech Stack:** TypeScript, sql.js (SQLite WASM), Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-cuda-profiling-design.md`

---

### Task 1: Add sql.js dependency and verify WASM loading

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install sql.js**

```bash
cd /Users/rwaugh/src/mine/tracemeld
npm install sql.js
```

- [ ] **Step 2: Verify sql.js types are bundled**

sql.js ships its own TypeScript declarations. Verify:

```bash
ls node_modules/sql.js/dist/sql-wasm.d.ts
```

If missing, install `@types/sql.js`. But sql.js v1.x bundles types.

- [ ] **Step 3: Write a smoke test to verify WASM init works**

Create `src/importers/nsight-sqlite.test.ts` with a minimal test:

```typescript
// src/importers/nsight-sqlite.test.ts
import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';

describe('sql.js WASM loading', () => {
  it('initializes sql.js and creates an in-memory database', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE test (id INTEGER, name TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    const result = db.exec('SELECT * FROM test');
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([[1, 'hello']]);
    db.close();
  });
});
```

- [ ] **Step 4: Run test**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/importers/nsight-sqlite.test.ts
git commit -m "chore: add sql.js dependency for Nsight SQLite import"
```

---

### Task 2: Add `'nsight-sqlite'` to ImportFormat and export mergeImportedProfile

**Files:**
- Modify: `src/importers/types.ts`
- Modify: `src/importers/import.ts`

- [ ] **Step 1: Add format to union type**

In `src/importers/types.ts`, change:

```typescript
export type ImportFormat = 'collapsed' | 'chrome_trace' | 'gecko' | 'pprof' | 'speedscope' | 'unknown';
```

to:

```typescript
export type ImportFormat = 'collapsed' | 'chrome_trace' | 'gecko' | 'nsight_sqlite' | 'pprof' | 'speedscope' | 'unknown';
```

Note: using `nsight_sqlite` (underscore) not `nsight-sqlite` (hyphen) to match the existing convention (`chrome_trace`).

- [ ] **Step 2: Export mergeImportedProfile**

In `src/importers/import.ts`, change `function mergeImportedProfile(` to `export function mergeImportedProfile(` (line 76). No other changes.

- [ ] **Step 3: Also export ImportProfileResult computation as a helper**

Add a helper function to `src/importers/import.ts` so server.ts can build the result from an ImportedProfile without duplicating the counting logic:

```typescript
export function buildImportResult(imported: ImportedProfile): ImportProfileResult {
  let samplesAdded = 0;
  let spansAdded = 0;
  for (const lane of imported.profile.lanes) {
    samplesAdded += lane.samples.length;
    spansAdded += lane.spans.length;
  }
  return {
    format_detected: imported.format,
    lanes_added: imported.profile.lanes.length,
    frames_added: imported.profile.frames.length,
    samples_added: samplesAdded,
    spans_added: spansAdded,
    value_types: imported.profile.value_types.map((vt) => vt.key),
  };
}
```

Then refactor `importProfile()` to use it (replace lines 34-56):

```typescript
  const imported = runImporter(content, name, format, symsJson);
  const result = buildImportResult(imported);

  if (mergeInto) {
    mergeImportedProfile(mergeInto, imported);
  }

  return result;
```

- [ ] **Step 4: Run all tests to verify no regressions**

```bash
npm test
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/importers/types.ts src/importers/import.ts
git commit -m "refactor: export mergeImportedProfile and add nsight_sqlite format"
```

---

### Task 3: Core importer — string table and table helpers

**Files:**
- Create: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for string table resolution**

Add to `src/importers/nsight-sqlite.test.ts`:

```typescript
import { importNsightSqlite } from './nsight-sqlite.js';
import type { Database } from 'sql.js';

describe('importNsightSqlite', () => {
  async function createTestDb(setup: (db: Database) => void): Promise<Uint8Array> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT)');
    setup(db);
    const data = db.export();
    db.close();
    return data;
  }

  it('resolves kernel names from StringIds table', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'matmul_f32')");
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
        start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER,
        contextId INTEGER, correlationId INTEGER,
        demangledName INTEGER, shortName INTEGER,
        gridX INTEGER, gridY INTEGER, gridZ INTEGER,
        blockX INTEGER, blockY INTEGER, blockZ INTEGER,
        staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
        registersPerThread INTEGER
      )`);
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (
        1000000, 2000000, 0, 1,
        0, 100,
        1, 1,
        128, 1, 1,
        256, 1, 1,
        0, 1024,
        32
      )`);
    });

    const result = await importNsightSqlite(data, 'test');
    const kernelLane = result.profile.lanes.find(l => l.id === 'gpu-0-kernels');
    expect(kernelLane).toBeDefined();
    expect(kernelLane!.spans).toHaveLength(1);

    const frame = result.profile.frames[kernelLane!.spans[0].frame_index];
    expect(frame.name).toBe('kernel:matmul_f32');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: FAIL — `importNsightSqlite` does not exist yet.

- [ ] **Step 3: Implement core importer skeleton**

Create `src/importers/nsight-sqlite.ts`:

```typescript
// src/importers/nsight-sqlite.ts
import type { ImportedProfile } from './types.js';
import type { Span, Marker, ValueType } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';
import initSqlJs, { type Database } from 'sql.js';

export interface NsightImportOptions {
  max_kernels?: number;
  time_range?: { start_ns: number; end_ns: number };
}

const NSIGHT_VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
  { key: 'bytes', unit: 'bytes', description: 'Bytes transferred (memcpy/memset)' },
  { key: 'threads', unit: 'none', description: 'Total thread count (grid * block)' },
  { key: 'shared_mem_bytes', unit: 'bytes', description: 'Shared memory per block (static + dynamic)' },
  { key: 'registers', unit: 'none', description: 'Registers per thread' },
];

// Value type indices
const V_WALL = 0;
const V_BYTES = 1;
const V_THREADS = 2;
const V_SHMEM = 3;
const V_REGS = 4;

function emptyValues(): number[] {
  return new Array(NSIGHT_VALUE_TYPES.length).fill(0);
}

function tableExists(db: Database, name: string): boolean {
  const result = db.exec(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`
  );
  return result.length > 0 && result[0].values.length > 0;
}

function buildStringTable(db: Database): Map<number, string> {
  const strings = new Map<number, string>();
  if (!tableExists(db, 'StringIds')) return strings;
  const result = db.exec('SELECT id, value FROM StringIds');
  if (result.length > 0) {
    for (const row of result[0].values) {
      strings.set(row[0] as number, row[1] as string);
    }
  }
  return strings;
}

function resolveString(strings: Map<number, string>, id: number | null | undefined): string {
  if (id == null) return 'unknown';
  return strings.get(id) ?? `unknown_${id}`;
}

export async function importNsightSqlite(
  data: Uint8Array,
  name: string,
  options?: NsightImportOptions,
): Promise<ImportedProfile> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(data);

  try {
    const frameTable = new FrameTable();
    const strings = buildStringTable(db);
    const lanes = new Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>();
    let spanCounter = 0;

    function nextSpanId(): string {
      return `ns${spanCounter++}`;
    }

    function getOrCreateLane(id: string, name: string, kind: 'worker' | 'custom') {
      let lane = lanes.get(id);
      if (!lane) {
        lane = { id, name, kind, spans: [], markers: [] };
        lanes.set(id, lane);
      }
      return lane;
    }

    // Import kernels
    if (tableExists(db, 'CUPTI_ACTIVITY_KIND_KERNEL')) {
      importKernels(db, strings, frameTable, lanes, options, nextSpanId, getOrCreateLane);
    }

    // Build profile
    const profile = {
      id: `nsight-${Date.now()}`,
      name,
      created_at: Date.now(),
      value_types: [...NSIGHT_VALUE_TYPES],
      categories: [],
      frames: frameTable.frames as ImportedProfile['profile']['frames'],
      lanes: [...lanes.values()].map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        samples: [],
        spans: l.spans,
        markers: l.markers,
      })),
      metadata: { source_format: 'nsight-sqlite' },
    };

    return { format: 'nsight_sqlite', profile };
  } finally {
    db.close();
  }
}

function importKernels(
  db: Database,
  strings: Map<number, string>,
  frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  options: NsightImportOptions | undefined,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  let query = 'SELECT * FROM CUPTI_ACTIVITY_KIND_KERNEL';
  if (options?.time_range) {
    query += ` WHERE start >= ${options.time_range.start_ns} AND end <= ${options.time_range.end_ns}`;
  }
  query += ' ORDER BY start';

  const result = db.exec(query);
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));
  let count = 0;

  for (const row of result[0].values) {
    if (options?.max_kernels && count >= options.max_kernels) {
      // Add truncation warning marker to first kernel lane
      const deviceId = row[colIdx['deviceId']] as number;
      const lane = getOrCreateLane(`gpu-${deviceId}-kernels`, `GPU ${deviceId}: Kernels`, 'worker');
      lane.markers.push({
        timestamp: (row[colIdx['start']] as number) / 1_000_000,
        name: `Truncated: imported ${count} of ${result[0].values.length} kernel events (max_kernels=${options.max_kernels})`,
        severity: 'warning',
      });
      break;
    }

    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    const deviceId = row[colIdx['deviceId']] as number;
    const streamId = row[colIdx['streamId']] as number;
    const contextId = row[colIdx['contextId']] as number;
    const correlationId = row[colIdx['correlationId']] as number;
    const demangledName = resolveString(strings, row[colIdx['demangledName']] as number);
    const gridX = row[colIdx['gridX']] as number;
    const gridY = row[colIdx['gridY']] as number;
    const gridZ = row[colIdx['gridZ']] as number;
    const blockX = row[colIdx['blockX']] as number;
    const blockY = row[colIdx['blockY']] as number;
    const blockZ = row[colIdx['blockZ']] as number;
    const staticShared = row[colIdx['staticSharedMemory']] as number;
    const dynamicShared = row[colIdx['dynamicSharedMemory']] as number;
    const regsPerThread = row[colIdx['registersPerThread']] as number;

    const frameIdx = frameTable.getOrInsert({ name: `kernel:${demangledName}` });
    const lane = getOrCreateLane(`gpu-${deviceId}-kernels`, `GPU ${deviceId}: Kernels`, 'worker');

    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;
    values[V_THREADS] = gridX * gridY * gridZ * blockX * blockY * blockZ;
    values[V_SHMEM] = staticShared + dynamicShared;
    values[V_REGS] = regsPerThread;

    const spanId = nextSpanId();
    lane.spans.push({
      id: spanId,
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: {
        deviceId, streamId, contextId, correlationId,
        gridDim: [gridX, gridY, gridZ],
        blockDim: [blockX, blockY, blockZ],
        start_ns: startNs,
        end_ns: endNs,
      },
      children: [],
    });

    count++;
  }
}
```

- [ ] **Step 4: Run test**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite importer — kernel import with string resolution"
```

---

### Task 4: Memcpy and memset import

**Files:**
- Modify: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for memcpy import**

```typescript
it('imports memcpy events with bytes and copy kind', async () => {
  const data = await createTestDb((db) => {
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (
      start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER,
      correlationId INTEGER, bytes INTEGER, copyKind INTEGER
    )`);
    // copyKind: 1=HtoD, 2=DtoH, 3=HtoH, 4=DtoD, 10=Peer
    db.run('INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (1000000, 1500000, 0, 1, 200, 4096, 1)');
  });

  const result = await importNsightSqlite(data, 'test');
  const memLane = result.profile.lanes.find(l => l.id === 'gpu-0-memory');
  expect(memLane).toBeDefined();
  expect(memLane!.spans).toHaveLength(1);

  const frame = result.profile.frames[memLane!.spans[0].frame_index];
  expect(frame.name).toBe('memcpy:HtoD');

  // Check bytes value type is populated
  const bytesIdx = result.profile.value_types.findIndex(vt => vt.key === 'bytes');
  expect(memLane!.spans[0].values[bytesIdx]).toBe(4096);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement memcpy and memset import**

Add to `src/importers/nsight-sqlite.ts`, after the kernel import in `importNsightSqlite`:

```typescript
if (tableExists(db, 'CUPTI_ACTIVITY_KIND_MEMCPY')) {
  importMemcpy(db, frameTable, lanes, options, nextSpanId, getOrCreateLane);
}

if (tableExists(db, 'CUPTI_ACTIVITY_KIND_MEMSET')) {
  importMemset(db, frameTable, lanes, options, nextSpanId, getOrCreateLane);
}
```

Add the copyKind label map and the two import functions:

```typescript
const COPY_KIND_LABELS: Record<number, string> = {
  1: 'HtoD', 2: 'DtoH', 3: 'HtoH', 4: 'DtoD', 10: 'Peer',
};

function importMemcpy(
  db: Database, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  options: NsightImportOptions | undefined,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  const result = db.exec('SELECT * FROM CUPTI_ACTIVITY_KIND_MEMCPY ORDER BY start');
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    if (options?.time_range && (startNs < options.time_range.start_ns || endNs > options.time_range.end_ns)) continue;

    const deviceId = row[colIdx['deviceId']] as number;
    const streamId = row[colIdx['streamId']] as number;
    const correlationId = row[colIdx['correlationId']] as number;
    const bytes = row[colIdx['bytes']] as number;
    const copyKind = row[colIdx['copyKind']] as number;
    const label = COPY_KIND_LABELS[copyKind] ?? `kind_${copyKind}`;

    const frameIdx = frameTable.getOrInsert({ name: `memcpy:${label}` });
    const lane = getOrCreateLane(`gpu-${deviceId}-memory`, `GPU ${deviceId}: Memory`, 'worker');

    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;
    values[V_BYTES] = bytes;

    lane.spans.push({
      id: nextSpanId(),
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: { deviceId, streamId, correlationId, copyKind, bytes, start_ns: startNs, end_ns: endNs },
      children: [],
    });
  }
}

function importMemset(
  db: Database, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  options: NsightImportOptions | undefined,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  const result = db.exec('SELECT * FROM CUPTI_ACTIVITY_KIND_MEMSET ORDER BY start');
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    if (options?.time_range && (startNs < options.time_range.start_ns || endNs > options.time_range.end_ns)) continue;

    const deviceId = row[colIdx['deviceId']] as number;
    const streamId = row[colIdx['streamId']] as number;
    const bytes = row[colIdx['bytes']] as number;

    const frameIdx = frameTable.getOrInsert({ name: 'memset' });
    const lane = getOrCreateLane(`gpu-${deviceId}-memory`, `GPU ${deviceId}: Memory`, 'worker');

    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;
    values[V_BYTES] = bytes;

    lane.spans.push({
      id: nextSpanId(),
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: { deviceId, streamId, bytes, start_ns: startNs, end_ns: endNs },
      children: [],
    });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite — memcpy and memset import"
```

---

### Task 5: CUDA Runtime API and correlation ID linkage

**Files:**
- Modify: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for correlation linkage**

```typescript
it('links kernel to runtime API span via correlationId', async () => {
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'cudaLaunchKernel'), (2, 'matmul_f32')");
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (
      start INTEGER, end INTEGER, nameId INTEGER, correlationId INTEGER
    )`);
    db.run('INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME VALUES (900000, 1100000, 1, 100)');
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
      start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER,
      contextId INTEGER, correlationId INTEGER,
      demangledName INTEGER, shortName INTEGER,
      gridX INTEGER, gridY INTEGER, gridZ INTEGER,
      blockX INTEGER, blockY INTEGER, blockZ INTEGER,
      staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
      registersPerThread INTEGER
    )`);
    db.run('INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (1000000, 2000000, 0, 1, 0, 100, 2, 2, 128, 1, 1, 256, 1, 1, 0, 0, 32)');
  });

  const result = await importNsightSqlite(data, 'test');

  // Find the runtime lane
  const runtimeLane = result.profile.lanes.find(l => l.id === 'cuda-runtime');
  expect(runtimeLane).toBeDefined();
  const apiSpan = runtimeLane!.spans[0];
  expect(result.profile.frames[apiSpan.frame_index].name).toBe('cuda_api:cudaLaunchKernel');

  // Kernel should be child of API span
  const kernelLane = result.profile.lanes.find(l => l.id === 'gpu-0-kernels');
  const kernelSpan = kernelLane!.spans[0];
  expect(kernelSpan.parent_id).toBe(apiSpan.id);
  expect(apiSpan.children).toContain(kernelSpan.id);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement runtime API import and correlation linkage**

In `importNsightSqlite`, add runtime API import **before** kernels and memcpy (so correlation map is ready):

```typescript
// Build correlation map from runtime API spans
const correlationMap = new Map<number, string>(); // correlationId → span_id

if (tableExists(db, 'CUPTI_ACTIVITY_KIND_RUNTIME')) {
  importRuntimeApi(db, strings, frameTable, lanes, correlationMap, nextSpanId, getOrCreateLane);
}

// Import kernels (with correlation linkage)
if (tableExists(db, 'CUPTI_ACTIVITY_KIND_KERNEL')) {
  importKernels(db, strings, frameTable, lanes, options, nextSpanId, getOrCreateLane, correlationMap);
}

// Import memcpy (with correlation linkage)
if (tableExists(db, 'CUPTI_ACTIVITY_KIND_MEMCPY')) {
  importMemcpy(db, frameTable, lanes, options, nextSpanId, getOrCreateLane, correlationMap);
}
```

Add the runtime import function:

```typescript
function importRuntimeApi(
  db: Database, strings: Map<number, string>, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  correlationMap: Map<number, string>,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  const result = db.exec('SELECT * FROM CUPTI_ACTIVITY_KIND_RUNTIME ORDER BY start');
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const lane = getOrCreateLane('cuda-runtime', 'CUDA Runtime API', 'custom');

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    const nameId = row[colIdx['nameId']] as number;
    const correlationId = row[colIdx['correlationId']] as number;
    const name = resolveString(strings, nameId);

    const frameIdx = frameTable.getOrInsert({ name: `cuda_api:${name}` });
    const spanId = nextSpanId();

    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;

    lane.spans.push({
      id: spanId,
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: { correlationId, start_ns: startNs, end_ns: endNs },
      children: [],
    });

    correlationMap.set(correlationId, spanId);
  }
}
```

Update `importKernels` and `importMemcpy` to accept and use the correlation map. After creating each span, link it:

```typescript
// In importKernels, after lane.spans.push(span):
const parentSpanId = correlationMap.get(correlationId);
if (parentSpanId) {
  span.parent_id = parentSpanId;
  // Find parent span and add child
  const runtimeLane = lanes.get('cuda-runtime');
  if (runtimeLane) {
    const parentSpan = runtimeLane.spans.find(s => s.id === parentSpanId);
    if (parentSpan) parentSpan.children.push(span.id);
  }
}
```

Same pattern for memcpy.

- [ ] **Step 4: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite — CUDA runtime API import with correlation linkage"
```

---

### Task 6: Synchronization events

**Files:**
- Modify: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test**

```typescript
it('imports synchronization events', async () => {
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'cudaDeviceSynchronize')");
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_SYNCHRONIZATION (
      start INTEGER, end INTEGER, nameId INTEGER
    )`);
    db.run('INSERT INTO CUPTI_ACTIVITY_KIND_SYNCHRONIZATION VALUES (5000000, 8000000, 1)');
  });

  const result = await importNsightSqlite(data, 'test');
  const runtimeLane = result.profile.lanes.find(l => l.id === 'cuda-runtime');
  expect(runtimeLane).toBeDefined();
  expect(runtimeLane!.spans).toHaveLength(1);
  const frame = result.profile.frames[runtimeLane!.spans[0].frame_index];
  expect(frame.name).toBe('cuda_sync:cudaDeviceSynchronize');
});
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Implement sync import**

Add sync import after runtime API in `importNsightSqlite`:

```typescript
if (tableExists(db, 'CUPTI_ACTIVITY_KIND_SYNCHRONIZATION')) {
  importSync(db, strings, frameTable, lanes, nextSpanId, getOrCreateLane);
}
```

```typescript
function importSync(
  db: Database, strings: Map<number, string>, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  const result = db.exec('SELECT * FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION ORDER BY start');
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const lane = getOrCreateLane('cuda-runtime', 'CUDA Runtime API', 'custom');

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    const nameId = colIdx['nameId'] !== undefined ? row[colIdx['nameId']] as number : null;
    const name = resolveString(strings, nameId);

    const frameIdx = frameTable.getOrInsert({ name: `cuda_sync:${name}` });
    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;

    lane.spans.push({
      id: nextSpanId(),
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: { start_ns: startNs, end_ns: endNs },
      children: [],
    });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite — synchronization event import"
```

---

### Task 7: NVTX ranges and marks

**Files:**
- Modify: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for NVTX push/pop ranges**

```typescript
it('pairs NVTX push/pop events into spans', async () => {
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'forward_pass')");
    db.run(`CREATE TABLE NVTX_EVENTS (
      start INTEGER, end INTEGER, globalTid INTEGER,
      textId INTEGER, text TEXT,
      eventType INTEGER, rangeId INTEGER,
      domainId INTEGER, category INTEGER, color INTEGER
    )`);
    // eventType 59 = push/pop range (end is populated)
    db.run("INSERT INTO NVTX_EVENTS VALUES (1000000, 5000000, 1, 1, NULL, 59, 0, 0, 0, 0)");
  });

  const result = await importNsightSqlite(data, 'test');
  const nvtxLane = result.profile.lanes.find(l => l.id === 'nvtx');
  expect(nvtxLane).toBeDefined();
  expect(nvtxLane!.spans).toHaveLength(1);
  const frame = result.profile.frames[nvtxLane!.spans[0].frame_index];
  expect(frame.name).toBe('nvtx:forward_pass');
});
```

- [ ] **Step 2: Write test for NVTX marks**

```typescript
it('converts NVTX mark events to markers', async () => {
  const data = await createTestDb((db) => {
    db.run(`CREATE TABLE NVTX_EVENTS (
      start INTEGER, end INTEGER, globalTid INTEGER,
      textId INTEGER, text TEXT,
      eventType INTEGER, rangeId INTEGER,
      domainId INTEGER, category INTEGER, color INTEGER
    )`);
    // eventType 34 = mark
    db.run("INSERT INTO NVTX_EVENTS VALUES (3000000, 0, 1, NULL, 'epoch_start', 34, 0, 0, 0, 255)");
  });

  const result = await importNsightSqlite(data, 'test');
  const nvtxLane = result.profile.lanes.find(l => l.id === 'nvtx');
  expect(nvtxLane).toBeDefined();
  expect(nvtxLane!.markers).toHaveLength(1);
  expect(nvtxLane!.markers[0].name).toBe('nvtx_mark:epoch_start');
  expect(nvtxLane!.markers[0].timestamp).toBe(3);
});
```

- [ ] **Step 3: Run tests, verify they fail**

- [ ] **Step 4: Implement NVTX import**

Add to `importNsightSqlite`:

```typescript
if (tableExists(db, 'NVTX_EVENTS')) {
  importNvtx(db, strings, frameTable, lanes, nextSpanId, getOrCreateLane);
}
```

```typescript
function importNvtx(
  db: Database, strings: Map<number, string>, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  const result = db.exec('SELECT * FROM NVTX_EVENTS ORDER BY start');
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const lane = getOrCreateLane('nvtx', 'NVTX Annotations', 'custom');

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number | null;
    const eventType = row[colIdx['eventType']] as number;
    const textId = colIdx['textId'] !== undefined ? row[colIdx['textId']] as number | null : null;
    const text = colIdx['text'] !== undefined ? row[colIdx['text']] as string | null : null;
    const color = colIdx['color'] !== undefined ? row[colIdx['color']] as number | null : null;

    // Resolve text: prefer textId from StringIds, fall back to raw text column
    const resolvedText = textId != null ? resolveString(strings, textId) : (text ?? 'unknown');

    if (eventType === 34) {
      // Mark — instant event
      lane.markers.push({
        timestamp: startNs / 1_000_000,
        name: `nvtx_mark:${resolvedText}`,
        severity: 'info',
        data: color != null ? { color } : undefined,
      });
    } else if (eventType === 59 || eventType === 60) {
      // Range — push/pop (59) or start/end (60)
      // Both have start and end populated in the NVTX_EVENTS table
      if (endNs == null || endNs === 0) continue;

      const frameIdx = frameTable.getOrInsert({ name: `nvtx:${resolvedText}` });
      const values = emptyValues();
      values[V_WALL] = (endNs - startNs) / 1_000_000;

      lane.spans.push({
        id: nextSpanId(),
        frame_index: frameIdx,
        parent_id: null,
        start_time: startNs / 1_000_000,
        end_time: endNs / 1_000_000,
        values,
        args: { start_ns: startNs, end_ns: endNs, eventType },
        children: [],
      });
    }
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite — NVTX ranges and marks"
```

---

### Task 8: cuBLAS and cuDNN import

**Files:**
- Modify: `src/importers/nsight-sqlite.ts`
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test**

```typescript
it('imports cuBLAS events', async () => {
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'cublasSgemm')");
    db.run(`CREATE TABLE CUBLAS_EVENTS (
      start INTEGER, end INTEGER, nameId INTEGER
    )`);
    db.run('INSERT INTO CUBLAS_EVENTS VALUES (2000000, 3000000, 1)');
  });

  const result = await importNsightSqlite(data, 'test');
  const lane = result.profile.lanes.find(l => l.id === 'cublas');
  expect(lane).toBeDefined();
  expect(lane!.spans).toHaveLength(1);
  const frame = result.profile.frames[lane!.spans[0].frame_index];
  expect(frame.name).toBe('cublas:cublasSgemm');
});
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Implement cuBLAS and cuDNN import**

Add a generic library event importer used for both:

```typescript
function importLibraryEvents(
  db: Database, tableName: string, framePrefix: string, laneId: string, laneName: string,
  strings: Map<number, string>, frameTable: FrameTable,
  lanes: Map<string, { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] }>,
  nextSpanId: () => string,
  getOrCreateLane: (id: string, name: string, kind: 'worker' | 'custom') => { id: string; name: string; kind: 'worker' | 'custom'; spans: Span[]; markers: Marker[] },
): void {
  if (!tableExists(db, tableName)) return;
  const result = db.exec(`SELECT * FROM ${tableName} ORDER BY start`);
  if (result.length === 0) return;

  const cols = result[0].columns;
  const colIdx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const lane = getOrCreateLane(laneId, laneName, 'custom');

  for (const row of result[0].values) {
    const startNs = row[colIdx['start']] as number;
    const endNs = row[colIdx['end']] as number;
    const nameId = row[colIdx['nameId']] as number;
    const name = resolveString(strings, nameId);

    const frameIdx = frameTable.getOrInsert({ name: `${framePrefix}:${name}` });
    const values = emptyValues();
    values[V_WALL] = (endNs - startNs) / 1_000_000;

    lane.spans.push({
      id: nextSpanId(),
      frame_index: frameIdx,
      parent_id: null,
      start_time: startNs / 1_000_000,
      end_time: endNs / 1_000_000,
      values,
      args: { start_ns: startNs, end_ns: endNs },
      children: [],
    });
  }
}
```

Wire it in `importNsightSqlite`:

```typescript
importLibraryEvents(db, 'CUBLAS_EVENTS', 'cublas', 'cublas', 'cuBLAS', strings, frameTable, lanes, nextSpanId, getOrCreateLane);
importLibraryEvents(db, 'CUDNN_EVENTS', 'cudnn', 'cudnn', 'cuDNN', strings, frameTable, lanes, nextSpanId, getOrCreateLane);
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/nsight-sqlite.ts src/importers/nsight-sqlite.test.ts
git commit -m "feat: nsight-sqlite — cuBLAS and cuDNN import"
```

---

### Task 9: Edge cases — missing tables and max_kernels cap

**Files:**
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for missing tables**

```typescript
it('succeeds with only StringIds and NVTX_EVENTS', async () => {
  const data = await createTestDb((db) => {
    db.run(`CREATE TABLE NVTX_EVENTS (
      start INTEGER, end INTEGER, globalTid INTEGER,
      textId INTEGER, text TEXT,
      eventType INTEGER, rangeId INTEGER,
      domainId INTEGER, category INTEGER, color INTEGER
    )`);
    db.run("INSERT INTO NVTX_EVENTS VALUES (1000000, 2000000, 1, NULL, 'test_range', 59, 0, 0, 0, 0)");
  });

  const result = await importNsightSqlite(data, 'test');
  expect(result.profile.lanes).toHaveLength(1);
  expect(result.profile.lanes[0].id).toBe('nvtx');
});
```

- [ ] **Step 2: Write test for max_kernels cap**

```typescript
it('caps kernel import at max_kernels and adds warning marker', async () => {
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'kernel_fn')");
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
      start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER,
      contextId INTEGER, correlationId INTEGER,
      demangledName INTEGER, shortName INTEGER,
      gridX INTEGER, gridY INTEGER, gridZ INTEGER,
      blockX INTEGER, blockY INTEGER, blockZ INTEGER,
      staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
      registersPerThread INTEGER
    )`);
    // Insert 50 kernels
    for (let i = 0; i < 50; i++) {
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (${i * 1000000}, ${(i + 1) * 1000000}, 0, 1, 0, ${i}, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 32)`);
    }
  });

  const result = await importNsightSqlite(data, 'test', { max_kernels: 10 });
  const kernelLane = result.profile.lanes.find(l => l.id === 'gpu-0-kernels');
  expect(kernelLane!.spans).toHaveLength(10);
  expect(kernelLane!.markers).toHaveLength(1);
  expect(kernelLane!.markers[0].severity).toBe('warning');
  expect(kernelLane!.markers[0].name).toContain('Truncated');
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS (these should work with the existing implementation from Tasks 3-8)

- [ ] **Step 4: Commit**

```bash
git add src/importers/nsight-sqlite.test.ts
git commit -m "test: nsight-sqlite edge cases — missing tables and max_kernels"
```

---

### Task 10: Wire into server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update import_profile tool handler**

In `src/server.ts`, add imports:

```typescript
import { importNsightSqlite } from './importers/nsight-sqlite.js';
import { mergeImportedProfile, buildImportResult } from './importers/import.js';
```

Update the format enum to include `'nsight_sqlite'`:

```typescript
format: z.enum(['auto', 'collapsed', 'chrome_trace', 'gecko', 'pprof', 'speedscope', 'nsight_sqlite']).optional(),
```

Add `nsight_options` to the input schema:

```typescript
nsight_options: z.object({
  max_kernels: z.number().optional(),
  time_range: z.object({
    start_ns: z.number(),
    end_ns: z.number(),
  }).optional(),
}).optional(),
```

Make the tool handler async and add the SQLite detection path. Replace the handler function (the third arg to `registerTool`) with:

```typescript
async (args) => {
  const format = args.format ?? 'auto';

  // Handle file-based sources
  if (!args.source.includes('\n') && existsSync(args.source)) {
    const rawBuffer = readFileSync(args.source);

    // Detect Nsight SQLite: check magic bytes or format hint
    const isSqlite = (rawBuffer.length >= 16 && rawBuffer.subarray(0, 15).toString('ascii') === 'SQLite format 3')
      || format === 'nsight_sqlite';

    if (isSqlite) {
      const imported = await importNsightSqlite(
        new Uint8Array(rawBuffer),
        args.lane_name ?? 'imported',
        args.nsight_options,
      );
      const result = buildImportResult(imported);
      mergeImportedProfile(state.builder, imported);
      state.invalidatePatternCache();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }

    // Existing path: gzip detection and string decode
    let content: string;
    if (rawBuffer.length >= 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b) {
      const decompressed = pako.ungzip(rawBuffer);
      content = Buffer.from(decompressed).toString('utf-8');
    } else {
      const isBinary = format === 'pprof' || args.source.endsWith('.pb.gz') || args.source.endsWith('.prof');
      content = isBinary ? rawBuffer.toString('latin1') : rawBuffer.toString('utf-8');
    }

    // Auto-detect samply .syms.json sidecar for Gecko profiles
    let symsJson: string | undefined;
    const basePath = args.source.endsWith('.gz') ? args.source.slice(0, -3) : args.source;
    const symsPath = basePath + '.syms.json';
    if (existsSync(symsPath)) {
      symsJson = readFileSync(symsPath, 'utf-8');
    }
    if (!symsJson) {
      const altSymsPath = args.source + '.syms.json';
      if (existsSync(altSymsPath)) {
        symsJson = readFileSync(altSymsPath, 'utf-8');
      }
    }

    const result = importProfile(content, args.lane_name ?? 'imported', format, state.builder, symsJson);
    state.invalidatePatternCache();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }

  // Inline string source (not a file)
  const content = args.source;
  const result = importProfile(content, args.lane_name ?? 'imported', format, state.builder);
  state.invalidatePatternCache();
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
},
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all pass

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: clean

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire nsight-sqlite importer into import_profile tool"
```

---

### Task 11: Merge pathway test

**Files:**
- Modify: `src/importers/nsight-sqlite.test.ts`

- [ ] **Step 1: Write test for merging GPU data into LLM profile**

```typescript
import { ProfileBuilder } from '../model/profile.js';
import { mergeImportedProfile } from './import.js';

it('merges nsight data into existing LLM profile builder', async () => {
  // Create a builder with default LLM value types (name is required)
  const builder = new ProfileBuilder('test-session');

  // Import nsight data
  const data = await createTestDb((db) => {
    db.run("INSERT INTO StringIds VALUES (1, 'matmul_f32')");
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
      start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER,
      contextId INTEGER, correlationId INTEGER,
      demangledName INTEGER, shortName INTEGER,
      gridX INTEGER, gridY INTEGER, gridZ INTEGER,
      blockX INTEGER, blockY INTEGER, blockZ INTEGER,
      staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
      registersPerThread INTEGER
    )`);
    db.run('INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (1000000, 2000000, 0, 1, 0, 100, 1, 1, 128, 1, 1, 256, 1, 1, 0, 1024, 32)');
  });

  const imported = await importNsightSqlite(data, 'test');
  mergeImportedProfile(builder, imported);

  // LLM value types should still be present, plus GPU-specific ones
  const keys = builder.profile.value_types.map(vt => vt.key);
  expect(keys).toContain('wall_ms');       // shared
  expect(keys).toContain('input_tokens');  // LLM-only
  expect(keys).toContain('threads');       // GPU-only

  // GPU span should have 0 for LLM-only dimensions
  const gpuLane = builder.profile.lanes.find(l => l.id.includes('gpu-0-kernels'));
  expect(gpuLane).toBeDefined();
  const span = gpuLane!.spans[0];
  expect(span.values.length).toBe(builder.profile.value_types.length);

  const tokensIdx = builder.profile.value_types.findIndex(vt => vt.key === 'input_tokens');
  expect(span.values[tokensIdx]).toBe(0);

  const threadsIdx = builder.profile.value_types.findIndex(vt => vt.key === 'threads');
  expect(span.values[threadsIdx]).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- src/importers/nsight-sqlite.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/importers/nsight-sqlite.test.ts
git commit -m "test: verify nsight-sqlite merge into LLM profile builder"
```

---

### Task 12: cuda-profiling skill

**Files:**
- Create: skill file in tracemeld plugin

The skill lives in the tracemeld plugin at:
`/Users/rwaugh/.claude/plugins/marketplaces/my-claude-plugins/plugins/tracemeld/skills/profile-cuda/SKILL.md`

- [ ] **Step 1: Create the skill directory and file**

```bash
mkdir -p /Users/rwaugh/.claude/plugins/marketplaces/my-claude-plugins/plugins/tracemeld/skills/profile-cuda
```

Write `SKILL.md`:

```markdown
---
name: profile-cuda
description: >
  Profile CUDA GPU workloads from Rust, C++, or Python programs using
  NVIDIA Nsight Systems. Capture kernel execution timelines, memory
  transfers, and NVTX annotations, then analyze them with tracemeld.
  Use when profiling CUDA code, GPU performance, kernel timing, or nsight.
---

# Profile CUDA GPU Applications

Guide the user through profiling a CUDA application with Nsight Systems, importing into tracemeld, and analyzing with existing tools.

## Prerequisites

- **NVIDIA GPU** with CUDA support
- **CUDA Toolkit** installed. Verify: `nvcc --version`
- **Nsight Systems** installed (bundled with CUDA Toolkit, or standalone).
  Verify: `nsys --version`

Typical paths if not on PATH:
- Linux: `/opt/nvidia/nsight-systems/<version>/bin/nsys`

## Step 1: Capture a profile

### Basic capture (any CUDA program)

```bash
nsys profile --trace=cuda,nvtx -o my_profile ./your_program [args...]
```

Produces `my_profile.nsys-rep`.

Key `--trace` options:
- `cuda` — Runtime API + GPU kernels/memcpy (essential)
- `nvtx` — User annotations (highly recommended)
- `cublas` — cuBLAS calls
- `cudnn` — cuDNN calls

### Capture a specific time range

```bash
nsys profile --trace=cuda,nvtx --duration=5 --delay=2 -o my_profile ./your_program
```

### Add NVTX annotations (Rust)

```toml
# Cargo.toml
[dependencies]
nvtx = "0.3"
```

```rust
fn train_step() {
    let _range = nvtx::range("train_step");
    {
        let _fwd = nvtx::range("forward_pass");
        // ... kernels ...
    }
    {
        let _bwd = nvtx::range("backward_pass");
        // ... kernels ...
    }
    nvtx::mark("optimizer_step_start");
}
```

### Add NVTX annotations (Python / PyTorch)

```python
import torch

with torch.cuda.nvtx.range("forward"):
    output = model(input_tensor)

with torch.cuda.nvtx.range("backward"):
    loss.backward()
```

### Add NVTX annotations (C++)

```cpp
#include <nvtx3/nvToolsExt.h>

nvtxRangePushA("forward_pass");
// ... CUDA kernels ...
nvtxRangePop();
```

## Step 2: Export to SQLite

```bash
nsys export --type sqlite my_profile.nsys-rep
```

Creates `my_profile.sqlite`.

## Step 3: Import into tracemeld

```
import_profile({
  source: "my_profile.sqlite",
  format: "nsight_sqlite"
})
```

For very large traces, cap the import:

```
import_profile({
  source: "my_profile.sqlite",
  format: "nsight_sqlite",
  nsight_options: { max_kernels: 50000 }
})
```

## Step 4: Analyze

### Overview

```
profile_summary({ group_by: "kind" })
```

Shows breakdown: kernel, memcpy, cuda_api, cuda_sync, nvtx categories.

### Find expensive kernels

```
hotspots({ dimension: "wall_ms", top_n: 10 })
```

Ranks all spans (CPU and GPU) by wall time. Kernel spans include grid/block dims in args.

### Detect GPU starvation

```
starvations({})
```

Detects GPU lanes idle while CPU is busy — the classic "GPU starving for work" pattern.

### Find bottlenecks

```
bottleneck({ dimension: "wall_ms" })
```

Combines self-cost with path criticality. For GPU profiles, shows where optimization has most impact.

### Examine a kernel

```
explain_span({ span_id: "<id from hotspots>" })
```

Shows: which CUDA API call launched it (parent_id linkage), grid/block dimensions, neighboring spans on the same stream (from span.args.streamId).

### Zoom into a function

```
focus_function({ function_name: "kernel:matmul" })
```

Aggregates all invocations of that kernel across the trace.

## Common optimization patterns

### Kernel is compute-bound
High register usage, full occupancy. → Algorithmic optimization, precision reduction (FP16/BF16), tensor cores.

### Kernel is memory-bound
Low compute utilization. → Memory coalescing, shared memory tiling, reduce global memory accesses.

### Launch overhead dominates
Many tiny kernels (< 10μs each). → Kernel fusion, CUDA Graphs, persistent kernels.

### CPU-GPU sync dominates
Lots of `cuda_sync:cudaDeviceSynchronize`. → Async operations, stream pipelining, remove unnecessary syncs.

### Memory transfer dominates
HtoD/DtoH takes significant wall time. → Pinned memory, overlap transfers with compute, minimize transfers.
```

- [ ] **Step 2: Verify the skill is loadable**

Check that the plugin picks it up:

```bash
ls /Users/rwaugh/.claude/plugins/marketplaces/my-claude-plugins/plugins/tracemeld/skills/profile-cuda/SKILL.md
```

- [ ] **Step 3: Commit the skill** (in the plugin repo)

```bash
cd /Users/rwaugh/.claude/plugins/marketplaces/my-claude-plugins
git add plugins/tracemeld/skills/profile-cuda/SKILL.md
git commit -m "feat: add profile-cuda skill for CUDA GPU profiling"
```

---

### Task 13: Smoke test with real nsys data (on CUDA machine)

This task requires being on a machine with an NVIDIA GPU and Nsight Systems.

- [ ] **Step 1: Create a minimal CUDA test program**

Use any available CUDA program, or a simple vector add:

```bash
cat > /tmp/vecadd.cu << 'EOF'
#include <stdio.h>
__global__ void vecAdd(float *a, float *b, float *c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}
int main() {
    int n = 1024 * 1024;
    float *a, *b, *c;
    cudaMallocManaged(&a, n * sizeof(float));
    cudaMallocManaged(&b, n * sizeof(float));
    cudaMallocManaged(&c, n * sizeof(float));
    for (int i = 0; i < n; i++) { a[i] = 1.0f; b[i] = 2.0f; }
    vecAdd<<<(n+255)/256, 256>>>(a, b, c, n);
    cudaDeviceSynchronize();
    printf("c[0] = %f\n", c[0]);
    cudaFree(a); cudaFree(b); cudaFree(c);
    return 0;
}
EOF
nvcc -o /tmp/vecadd /tmp/vecadd.cu
```

- [ ] **Step 2: Capture with nsys**

```bash
nsys profile --trace=cuda -o /tmp/vecadd_profile /tmp/vecadd
```

- [ ] **Step 3: Export to SQLite**

```bash
nsys export --type sqlite /tmp/vecadd_profile.nsys-rep
```

- [ ] **Step 4: Inspect the SQLite schema**

```bash
sqlite3 /tmp/vecadd_profile.sqlite ".tables"
sqlite3 /tmp/vecadd_profile.sqlite ".schema CUPTI_ACTIVITY_KIND_KERNEL"
sqlite3 /tmp/vecadd_profile.sqlite "SELECT * FROM CUPTI_ACTIVITY_KIND_KERNEL LIMIT 3"
```

Compare column names with what the importer expects. Adjust importer column names if the real schema differs from the spec.

- [ ] **Step 5: Test import via MCP Inspector**

```bash
npm run inspect
```

In the inspector, call `import_profile` with:
```json
{ "source": "/tmp/vecadd_profile.sqlite" }
```

Verify auto-detection works (SQLite magic bytes → nsight_sqlite).

- [ ] **Step 6: Run analysis**

In the inspector, call:
- `profile_summary({ "group_by": "kind" })`
- `hotspots({ "dimension": "wall_ms" })`
- `starvations({})`

Verify results are sensible: kernel shows up, memcpy shows up, wall times are plausible.

- [ ] **Step 7: Fix any issues found, commit**

If column names differ from the spec, update the importer and tests.
