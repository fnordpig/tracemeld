# Core Model & Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working MCP server that can instrument LLM work sessions via `trace` and `mark` tools, with a canonical data model that all future analysis/import/export tools will build on.

**Architecture:** The canonical `Profile` holds deduplicated `Frame`s referenced by index, `Lane`s containing `Span`s/`Sample`s/`Marker`s, and multi-dimensional `ValueType`s. `ProfilerState` manages server-lifetime state with an implicit span stack for the `trace` tool. The MCP SDK wires tools to state mutations over stdio.

**Tech Stack:** TypeScript 5, MCP SDK (`@modelcontextprotocol/sdk`), Zod 4 for schemas, Vitest for tests.

**Scope note:** This is Plan 1 of ~4. Future plans cover: (2) analysis tools, (3) importers, (4) exporters + anti-pattern detection. Each plan produces working, testable software.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/model/types.ts` | All canonical data model interfaces (`Profile`, `Frame`, `Lane`, `Span`, `Sample`, `Marker`, `ValueType`, etc.) |
| `src/model/frame-table.ts` | Deduplicated frame registry — `getOrInsertFrame()` returns index |
| `src/model/profile.ts` | `ProfileBuilder` class — constructs and mutates a `Profile` (add lanes, spans, samples, markers) |
| `src/model/state.ts` | `ProfilerState` class — server-lifetime state, span stacks, ID generation |
| `src/instrument/trace.ts` | `trace` tool handler — begin/end spans with implicit stack management |
| `src/instrument/mark.ts` | `mark` tool handler — instant marker recording |
| `src/server.ts` | MCP server setup, tool registration, state initialization |
| `src/cli.ts` | CLI entry point (already exists) |
| `src/index.ts` | Public API exports (already exists) |

Test files mirror source: `src/model/frame-table.test.ts`, `src/model/profile.test.ts`, `src/model/state.test.ts`, `src/instrument/trace.test.ts`, `src/instrument/mark.test.ts`.

---

### Task 1: Canonical Data Model Types

**Files:**
- Create: `src/model/types.ts`

No tests needed — these are pure type definitions.

- [ ] **Step 1: Write the type definitions**

```typescript
// src/model/types.ts

export type Unit =
  | 'nanoseconds'
  | 'microseconds'
  | 'milliseconds'
  | 'seconds'
  | 'bytes'
  | 'none';

export interface ValueType {
  key: string;
  unit: Unit;
  description?: string;
}

export interface Category {
  name: string;
  color?: string;
  subcategories?: string[];
}

export interface Frame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
  category_index?: number;
  metadata?: Record<string, unknown>;
}

export interface Sample {
  timestamp: number | null;
  stack: number[];
  values: number[];
  labels?: Record<string, string | number>[];
}

export interface Span {
  id: string;
  frame_index: number;
  parent_id: string | null;
  start_time: number;
  end_time: number;
  values: number[];
  args: Record<string, unknown>;
  error?: string;
  children: string[];
}

export interface Marker {
  timestamp: number;
  name: string;
  category_index?: number;
  severity?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
  end_time?: number;
}

export type LaneKind = 'main' | 'worker' | 'agent' | 'subprocess' | 'custom';

export interface Lane {
  id: string;
  name: string;
  pid?: number;
  tid?: number;
  kind: LaneKind;
  samples: Sample[];
  spans: Span[];
  markers: Marker[];
}

export interface Profile {
  id: string;
  name: string;
  created_at: number;
  value_types: ValueType[];
  categories: Category[];
  frames: Frame[];
  lanes: Lane[];
  metadata: Record<string, unknown>;
}

export interface DetectedPattern {
  name: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  evidence: Record<string, unknown>;
  span_ids?: string[];
}

export const LLM_VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
  { key: 'input_tokens', unit: 'none', description: 'Input/prompt tokens consumed' },
  { key: 'output_tokens', unit: 'none', description: 'Output/completion tokens generated' },
  { key: 'cost_usd', unit: 'none', description: 'Estimated dollar cost' },
  { key: 'bytes_read', unit: 'bytes', description: 'Bytes read from disk/network' },
  { key: 'bytes_written', unit: 'bytes', description: 'Bytes written to disk/network' },
];
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/model/types.ts
git commit -m "feat: add canonical data model types"
```

---

### Task 2: Frame Table

**Files:**
- Create: `src/model/frame-table.ts`
- Test: `src/model/frame-table.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/model/frame-table.test.ts
import { describe, it, expect } from 'vitest';
import { FrameTable } from './frame-table.js';

describe('FrameTable', () => {
  it('returns index 0 for the first inserted frame', () => {
    const table = new FrameTable();
    const idx = table.getOrInsert({ name: 'bash:npm test' });
    expect(idx).toBe(0);
  });

  it('returns the same index for duplicate frames', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'bash:npm test' });
    const idx2 = table.getOrInsert({ name: 'bash:npm test' });
    expect(idx1).toBe(idx2);
  });

  it('returns different indices for different frames', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'bash:npm test' });
    const idx2 = table.getOrInsert({ name: 'file_read:src/auth.ts' });
    expect(idx1).not.toBe(idx2);
  });

  it('deduplicates by name+file+line+col+category', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 10 });
    const idx2 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 10 });
    const idx3 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 20 });
    expect(idx1).toBe(idx2);
    expect(idx1).not.toBe(idx3);
  });

  it('exposes frames as a readonly array', () => {
    const table = new FrameTable();
    table.getOrInsert({ name: 'a' });
    table.getOrInsert({ name: 'b' });
    expect(table.frames).toHaveLength(2);
    expect(table.frames[0].name).toBe('a');
    expect(table.frames[1].name).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/frame-table.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/model/frame-table.ts
import type { Frame } from './types.js';

export class FrameTable {
  private _frames: Frame[] = [];
  private _index = new Map<string, number>();

  private key(frame: Frame): string {
    return `${frame.name}\0${frame.file ?? ''}\0${frame.line ?? ''}\0${frame.col ?? ''}\0${frame.category_index ?? ''}`;
  }

  getOrInsert(frame: Frame): number {
    const k = this.key(frame);
    const existing = this._index.get(k);
    if (existing !== undefined) return existing;

    const idx = this._frames.length;
    this._frames.push({ ...frame });
    this._index.set(k, idx);
    return idx;
  }

  get(index: number): Frame | undefined {
    return this._frames[index];
  }

  get frames(): readonly Frame[] {
    return this._frames;
  }

  get length(): number {
    return this._frames.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/frame-table.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/frame-table.ts src/model/frame-table.test.ts
git commit -m "feat: add deduplicated frame table"
```

---

### Task 3: Profile Builder

**Files:**
- Create: `src/model/profile.ts`
- Test: `src/model/profile.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/model/profile.test.ts
import { describe, it, expect } from 'vitest';
import { ProfileBuilder } from './profile.js';
import { LLM_VALUE_TYPES } from './types.js';

describe('ProfileBuilder', () => {
  it('creates a profile with default LLM value types', () => {
    const builder = new ProfileBuilder('test-session');
    const profile = builder.profile;
    expect(profile.name).toBe('test-session');
    expect(profile.value_types).toEqual(LLM_VALUE_TYPES);
    expect(profile.lanes).toHaveLength(1);
    expect(profile.lanes[0].id).toBe('main');
    expect(profile.lanes[0].kind).toBe('main');
  });

  it('creates a profile with custom value types', () => {
    const builder = new ProfileBuilder('custom', [
      { key: 'cpu_ns', unit: 'nanoseconds' },
    ]);
    expect(builder.profile.value_types).toHaveLength(1);
    expect(builder.profile.value_types[0].key).toBe('cpu_ns');
  });

  it('adds a lane', () => {
    const builder = new ProfileBuilder('test');
    const lane = builder.addLane('worker-1', 'worker');
    expect(lane.id).toBe('worker-1');
    expect(lane.kind).toBe('worker');
    expect(builder.profile.lanes).toHaveLength(2); // main + worker-1
  });

  it('gets a lane by id', () => {
    const builder = new ProfileBuilder('test');
    const lane = builder.getLane('main');
    expect(lane).toBeDefined();
    expect(lane!.name).toBe('main');
  });

  it('adds a span to a lane', () => {
    const builder = new ProfileBuilder('test');
    const frameIdx = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    const span = builder.addSpan('main', {
      id: 's1',
      frame_index: frameIdx,
      parent_id: null,
      start_time: 100,
      end_time: 200,
      values: [100, 0, 0, 0, 0, 0],
      args: {},
      children: [],
    });
    expect(span.id).toBe('s1');
    expect(builder.getLane('main')!.spans).toHaveLength(1);
  });

  it('adds a marker to a lane', () => {
    const builder = new ProfileBuilder('test');
    builder.addMarker('main', {
      timestamp: 150,
      name: 'test failure',
      severity: 'error',
    });
    expect(builder.getLane('main')!.markers).toHaveLength(1);
  });

  it('adds a sample to a lane', () => {
    const builder = new ProfileBuilder('test');
    builder.frameTable.getOrInsert({ name: 'func_a' });
    builder.addSample('main', {
      timestamp: null,
      stack: [0],
      values: [1],
    });
    expect(builder.getLane('main')!.samples).toHaveLength(1);
  });

  it('deduplicates frames through the frame table', () => {
    const builder = new ProfileBuilder('test');
    const idx1 = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    const idx2 = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    expect(idx1).toBe(idx2);
    expect(builder.profile.frames).toHaveLength(1);
  });

  it('resolves value type index by key', () => {
    const builder = new ProfileBuilder('test');
    expect(builder.valueTypeIndex('wall_ms')).toBe(0);
    expect(builder.valueTypeIndex('input_tokens')).toBe(1);
    expect(builder.valueTypeIndex('nonexistent')).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/model/profile.ts
import type { Profile, ValueType, Lane, LaneKind, Span, Sample, Marker, Frame } from './types.js';
import { LLM_VALUE_TYPES } from './types.js';
import { FrameTable } from './frame-table.js';

export class ProfileBuilder {
  readonly profile: Profile;
  readonly frameTable: FrameTable;
  private _valueTypeIndex: Map<string, number>;

  constructor(name: string, valueTypes?: ValueType[]) {
    const vt = valueTypes ?? [...LLM_VALUE_TYPES];
    this.frameTable = new FrameTable();

    this._valueTypeIndex = new Map();
    for (let i = 0; i < vt.length; i++) {
      this._valueTypeIndex.set(vt[i].key, i);
    }

    this.profile = {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: vt,
      categories: [],
      frames: this.frameTable.frames as Frame[],
      lanes: [],
      metadata: {},
    };

    // Create default main lane
    this.addLane('main', 'main');
  }

  addLane(id: string, kind: LaneKind = 'custom'): Lane {
    const lane: Lane = {
      id,
      name: id,
      kind,
      samples: [],
      spans: [],
      markers: [],
    };
    this.profile.lanes.push(lane);
    return lane;
  }

  getLane(id: string): Lane | undefined {
    return this.profile.lanes.find((l) => l.id === id);
  }

  addSpan(laneId: string, span: Span): Span {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.spans.push(span);
    return span;
  }

  addSample(laneId: string, sample: Sample): Sample {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.samples.push(sample);
    return sample;
  }

  addMarker(laneId: string, marker: Marker): Marker {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.markers.push(marker);
    return marker;
  }

  valueTypeIndex(key: string): number {
    return this._valueTypeIndex.get(key) ?? -1;
  }

  /** Build a zero-filled values array for the current value_types. */
  emptyValues(): number[] {
    return new Array<number>(this.profile.value_types.length).fill(0);
  }

  /** Merge a cost record into a values array. */
  mergeCost(values: number[], cost: Record<string, number>): void {
    for (const [key, val] of Object.entries(cost)) {
      const idx = this.valueTypeIndex(key);
      if (idx >= 0) values[idx] += val;
    }
  }
}
```

Note: The `Profile.frames` is a reference to `frameTable.frames` (the same array). The type cast `as Frame[]` bridges readonly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/profile.test.ts`
Expected: All 9 tests PASS.

- [ ] **Step 5: Lint check**

Run: `npx eslint src/model/`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/model/profile.ts src/model/profile.test.ts
git commit -m "feat: add profile builder with lane/span/sample/marker management"
```

---

### Task 4: Profiler State

**Files:**
- Create: `src/model/state.ts`
- Test: `src/model/state.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/model/state.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from './state.js';

describe('ProfilerState', () => {
  it('initializes with a default profile and main lane', () => {
    const state = new ProfilerState();
    expect(state.builder.profile.name).toBe('session');
    expect(state.builder.getLane('main')).toBeDefined();
  });

  it('generates unique span IDs', () => {
    const state = new ProfilerState();
    const id1 = state.nextSpanId();
    const id2 = state.nextSpanId();
    expect(id1).not.toBe(id2);
  });

  it('generates unique marker IDs', () => {
    const state = new ProfilerState();
    const id1 = state.nextMarkerId();
    const id2 = state.nextMarkerId();
    expect(id1).not.toBe(id2);
  });

  it('manages span stack per lane', () => {
    const state = new ProfilerState();
    state.pushSpan('main', 's1');
    state.pushSpan('main', 's2');
    expect(state.currentSpanId('main')).toBe('s2');
    expect(state.spanDepth('main')).toBe(2);

    expect(state.popSpan('main')).toBe('s2');
    expect(state.currentSpanId('main')).toBe('s1');
    expect(state.spanDepth('main')).toBe(1);
  });

  it('returns null for empty span stack', () => {
    const state = new ProfilerState();
    expect(state.currentSpanId('main')).toBeNull();
    expect(state.popSpan('main')).toBeNull();
    expect(state.spanDepth('main')).toBe(0);
  });

  it('invalidates pattern cache on mutation', () => {
    const state = new ProfilerState();
    state.patternCache = []; // simulate cached patterns
    expect(state.patternCache).not.toBeNull();
    state.invalidatePatternCache();
    expect(state.patternCache).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/model/state.ts
import { ProfileBuilder } from './profile.js';
import type { DetectedPattern } from './types.js';

export class ProfilerState {
  readonly builder: ProfileBuilder;
  readonly imported = new Map<string, ProfileBuilder>();
  private spanStacks = new Map<string, string[]>();
  activeLaneId = 'main';
  patternCache: DetectedPattern[] | null = null;
  private _nextSpanId = 0;
  private _nextMarkerId = 0;

  constructor() {
    this.builder = new ProfileBuilder('session');
  }

  nextSpanId(): string {
    return `s${this._nextSpanId++}`;
  }

  nextMarkerId(): string {
    return `m${this._nextMarkerId++}`;
  }

  pushSpan(laneId: string, spanId: string): void {
    let stack = this.spanStacks.get(laneId);
    if (!stack) {
      stack = [];
      this.spanStacks.set(laneId, stack);
    }
    stack.push(spanId);
    this.invalidatePatternCache();
  }

  popSpan(laneId: string): string | null {
    const stack = this.spanStacks.get(laneId);
    if (!stack || stack.length === 0) return null;
    this.invalidatePatternCache();
    return stack.pop()!;
  }

  currentSpanId(laneId: string): string | null {
    const stack = this.spanStacks.get(laneId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1];
  }

  spanDepth(laneId: string): number {
    return this.spanStacks.get(laneId)?.length ?? 0;
  }

  invalidatePatternCache(): void {
    this.patternCache = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/state.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/state.ts src/model/state.test.ts src/model/types.ts
git commit -m "feat: add profiler state with span stack management"
```

---

### Task 5: Trace Tool (begin/end spans)

**Files:**
- Create: `src/instrument/trace.ts`
- Test: `src/instrument/trace.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/instrument/trace.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from './trace.js';

describe('handleTrace', () => {
  it('begins a span and returns span_id and depth', () => {
    const state = new ProfilerState();
    const result = handleTrace(state, {
      action: 'begin',
      kind: 'bash',
      name: 'npm test',
    });
    expect(result.span_id).toBeDefined();
    expect(result.depth).toBe(1);
    expect(result.parent_id).toBeUndefined();
  });

  it('nests spans correctly', () => {
    const state = new ProfilerState();
    const r1 = handleTrace(state, { action: 'begin', kind: 'turn' });
    const r2 = handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    expect(r2.depth).toBe(2);
    expect(r2.parent_id).toBe(r1.span_id);
  });

  it('ends a span and returns elapsed_ms', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });

    const result = handleTrace(state, {
      action: 'end',
      kind: 'bash',
      cost: { wall_ms: 3400 },
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(result.depth).toBe(0);
  });

  it('creates frame as kind:name', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    const frame = state.builder.profile.frames[0];
    expect(frame.name).toBe('bash:npm test');
  });

  it('defaults name to kind when name is omitted', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'thinking' });
    const frame = state.builder.profile.frames[0];
    expect(frame.name).toBe('thinking');
  });

  it('merges cost into span values on end', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, {
      action: 'end',
      kind: 'bash',
      cost: { wall_ms: 5000, input_tokens: 100 },
    });
    const span = state.builder.getLane('main')!.spans[0];
    expect(span.values[0]).toBe(5000); // wall_ms at index 0
    expect(span.values[1]).toBe(100);  // input_tokens at index 1
  });

  it('records error on span when provided on end', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, {
      action: 'end',
      kind: 'bash',
      error: 'exit code 1',
    });
    const span = state.builder.getLane('main')!.spans[0];
    expect(span.error).toBe('exit code 1');
  });

  it('auto-closes mismatched stack top with warning', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn' });
    handleTrace(state, { action: 'begin', kind: 'bash' });
    // End 'turn' while 'bash' is on top — should auto-close bash first
    handleTrace(state, { action: 'end', kind: 'turn' });

    const spans = state.builder.getLane('main')!.spans;
    expect(spans).toHaveLength(2);
    // bash span should have auto_closed metadata
    const bashSpan = spans.find((s) =>
      state.builder.profile.frames[s.frame_index].name === 'bash'
    );
    expect(bashSpan?.args['auto_closed']).toBe(true);
  });

  it('handles end with empty stack gracefully', () => {
    const state = new ProfilerState();
    const result = handleTrace(state, { action: 'end', kind: 'bash' });
    // Should not throw, returns a no-op result
    expect(result.span_id).toBe('');
    expect(result.depth).toBe(0);
  });

  it('attaches metadata to span args', () => {
    const state = new ProfilerState();
    handleTrace(state, {
      action: 'begin',
      kind: 'bash',
      metadata: { command: 'npm test' },
    });
    const span = state.builder.getLane('main')!.spans[0];
    expect(span.args['command']).toBe('npm test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/instrument/trace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/instrument/trace.ts
import type { ProfilerState } from '../model/state.js';

export interface TraceInput {
  action: 'begin' | 'end';
  kind: string;
  name?: string;
  cost?: Record<string, number>;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceResult {
  span_id: string;
  depth: number;
  elapsed_ms?: number;
  parent_id?: string;
}

export function handleTrace(state: ProfilerState, input: TraceInput): TraceResult {
  const laneId = state.activeLaneId;

  if (input.action === 'begin') {
    return handleBegin(state, laneId, input);
  } else {
    return handleEnd(state, laneId, input);
  }
}

function handleBegin(state: ProfilerState, laneId: string, input: TraceInput): TraceResult {
  const frameName = input.name ? `${input.kind}:${input.name}` : input.kind;
  const frameIdx = state.builder.frameTable.getOrInsert({ name: frameName });
  const spanId = state.nextSpanId();
  const parentId = state.currentSpanId(laneId);
  const now = Date.now();

  const span = state.builder.addSpan(laneId, {
    id: spanId,
    frame_index: frameIdx,
    parent_id: parentId,
    start_time: now,
    end_time: now, // will be updated on end
    values: state.builder.emptyValues(),
    args: input.metadata ? { ...input.metadata } : {},
    children: [],
  });

  // Update parent's children list
  if (parentId) {
    const lane = state.builder.getLane(laneId);
    const parent = lane?.spans.find((s) => s.id === parentId);
    if (parent) parent.children.push(spanId);
  }

  state.pushSpan(laneId, spanId);

  return {
    span_id: spanId,
    depth: state.spanDepth(laneId),
    parent_id: parentId ?? undefined,
  };
}

function handleEnd(state: ProfilerState, laneId: string, input: TraceInput): TraceResult {
  const lane = state.builder.getLane(laneId);
  if (!lane) return { span_id: '', depth: 0 };

  const currentId = state.currentSpanId(laneId);
  if (!currentId) return { span_id: '', depth: 0 };

  // Find the span matching this kind
  const targetKind = input.name ? `${input.kind}:${input.name}` : input.kind;

  // Check if current stack top matches
  const topSpan = lane.spans.find((s) => s.id === currentId);
  if (!topSpan) return { span_id: '', depth: 0 };

  const topFrameName = state.builder.profile.frames[topSpan.frame_index]?.name;

  if (topFrameName !== targetKind && !topFrameName?.startsWith(`${input.kind}:`)) {
    // Mismatch: auto-close spans until we find a match or exhaust the stack
    autoCloseUntilMatch(state, laneId, input.kind);
  }

  // Now close the current top
  const spanId = state.currentSpanId(laneId);
  if (!spanId) return { span_id: '', depth: 0 };

  const span = lane.spans.find((s) => s.id === spanId);
  if (!span) return { span_id: '', depth: 0 };

  const now = Date.now();
  span.end_time = now;
  const elapsed = now - span.start_time;

  if (input.cost) {
    state.builder.mergeCost(span.values, input.cost);
  }
  if (input.error) {
    span.error = input.error;
  }
  if (input.metadata) {
    Object.assign(span.args, input.metadata);
  }

  state.popSpan(laneId);

  return {
    span_id: span.id,
    depth: state.spanDepth(laneId),
    elapsed_ms: elapsed,
  };
}

function autoCloseUntilMatch(state: ProfilerState, laneId: string, kind: string): void {
  const lane = state.builder.getLane(laneId);
  if (!lane) return;

  // Close spans from the top until we find one matching the kind
  let safety = 100;
  while (safety-- > 0) {
    const topId = state.currentSpanId(laneId);
    if (!topId) break;

    const topSpan = lane.spans.find((s) => s.id === topId);
    if (!topSpan) break;

    const frameName = state.builder.profile.frames[topSpan.frame_index]?.name ?? '';
    if (frameName === kind || frameName.startsWith(`${kind}:`)) {
      break; // Found the match, stop auto-closing
    }

    // Auto-close this span
    topSpan.end_time = Date.now();
    topSpan.args['auto_closed'] = true;
    state.popSpan(laneId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/instrument/trace.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Lint check**

Run: `npx eslint src/instrument/trace.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/instrument/trace.ts src/instrument/trace.test.ts
git commit -m "feat: add trace tool with begin/end span management"
```

---

### Task 6: Mark Tool

**Files:**
- Create: `src/instrument/mark.ts`
- Test: `src/instrument/mark.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/instrument/mark.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleMark } from './mark.js';

describe('handleMark', () => {
  it('creates a marker with timestamp', () => {
    const state = new ProfilerState();
    const result = handleMark(state, { what: 'test failure' });
    expect(result.marker_id).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('records severity on the marker', () => {
    const state = new ProfilerState();
    handleMark(state, { what: 'tests failed', severity: 'error' });
    const marker = state.builder.getLane('main')!.markers[0];
    expect(marker.severity).toBe('error');
  });

  it('defaults severity to info', () => {
    const state = new ProfilerState();
    handleMark(state, { what: 'checkpoint' });
    const marker = state.builder.getLane('main')!.markers[0];
    expect(marker.severity).toBe('info');
  });

  it('attaches structured data', () => {
    const state = new ProfilerState();
    handleMark(state, {
      what: 'context pressure',
      data: { utilization: 0.78 },
    });
    const marker = state.builder.getLane('main')!.markers[0];
    expect(marker.data).toEqual({ utilization: 0.78 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/instrument/mark.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/instrument/mark.ts
import type { ProfilerState } from '../model/state.js';

export interface MarkInput {
  what: string;
  severity?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface MarkResult {
  marker_id: string;
  timestamp: number;
}

export function handleMark(state: ProfilerState, input: MarkInput): MarkResult {
  const laneId = state.activeLaneId;
  const markerId = state.nextMarkerId();
  const timestamp = Date.now();

  state.builder.addMarker(laneId, {
    timestamp,
    name: input.what,
    severity: input.severity ?? 'info',
    data: input.data,
  });

  return { marker_id: markerId, timestamp };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/instrument/mark.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/instrument/mark.ts src/instrument/mark.test.ts
git commit -m "feat: add mark tool for instant markers"
```

---

### Task 7: Wire Tools into MCP Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from './server.js';

interface TraceResult {
  span_id: string;
  depth: number;
  elapsed_ms?: number;
  parent_id?: string;
}

interface MarkResult {
  marker_id: string;
  timestamp: number;
}

let client: Client;
let server: McpServer;

async function createTestClient(): Promise<Client> {
  server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function parseToolResult<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as T;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
});

describe('MCP Server', () => {
  it('lists trace and mark tools', async () => {
    await createTestClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('trace');
    expect(names).toContain('mark');
  });

  it('trace begin returns span_id', async () => {
    await createTestClient();
    const result = await client.callTool({
      name: 'trace',
      arguments: { action: 'begin', kind: 'thinking', name: 'planning' },
    });
    const parsed = parseToolResult<TraceResult>(result);
    expect(parsed.span_id).toBeDefined();
    expect(parsed.depth).toBe(1);
  });

  it('trace end returns elapsed_ms', async () => {
    await createTestClient();
    await client.callTool({
      name: 'trace',
      arguments: { action: 'begin', kind: 'bash' },
    });
    const result = await client.callTool({
      name: 'trace',
      arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } },
    });
    const parsed = parseToolResult<TraceResult>(result);
    expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.depth).toBe(0);
  });

  it('mark returns marker_id and timestamp', async () => {
    await createTestClient();
    const result = await client.callTool({
      name: 'mark',
      arguments: { what: 'test checkpoint', severity: 'info' },
    });
    const parsed = parseToolResult<MarkResult>(result);
    expect(parsed.marker_id).toBeDefined();
    expect(parsed.timestamp).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Update server.ts to register tools**

```typescript
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProfilerState } from './model/state.js';
import { handleTrace } from './instrument/trace.js';
import { handleMark } from './instrument/mark.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'tracemeld',
    version: '0.1.0',
  });

  const state = new ProfilerState();

  server.tool(
    'trace',
    "Mark the start or end of a unit of work. Use this to instrument your own operations while you work: thinking, tool calls, file reads, bash commands, test runs. Call with action 'begin' before starting, 'end' when done. Cost data (tokens, time, bytes) goes on the 'end' call. Nesting is automatic.",
    {
      action: z.enum(['begin', 'end']),
      kind: z.string(),
      name: z.string().optional(),
      cost: z.record(z.string(), z.number()).optional(),
      error: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => {
      const result = handleTrace(state, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'mark',
    "Record a notable instant: a test failure, a decision point, context window pressure, an unexpected result. Not a duration — a moment.",
    {
      what: z.string(),
      severity: z.enum(['info', 'warning', 'error']).optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => {
      const result = handleMark(state, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Build and smoke test the MCP server**

Run: `npx tsc && echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | node build/cli.js`

Expected: JSON response with `serverInfo.name: "tracemeld"`.

- [ ] **Step 6: Run full test suite and lint**

Run: `npx vitest run && npx eslint src/`
Expected: All tests pass, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: wire trace and mark tools into MCP server"
```

---

### Task 8: Update Exports and Add CLAUDE.md

**Files:**
- Modify: `src/index.ts`
- Create: `CLAUDE.md`

- [ ] **Step 1: Update index.ts**

```typescript
// src/index.ts
export { createServer, startServer } from './server.js';
export type {
  Profile,
  Frame,
  Lane,
  Span,
  Sample,
  Marker,
  ValueType,
  Category,
  DetectedPattern,
} from './model/types.js';
export { LLM_VALUE_TYPES } from './model/types.js';
export { ProfileBuilder } from './model/profile.js';
export { FrameTable } from './model/frame-table.js';
export { ProfilerState } from './model/state.js';
```

- [ ] **Step 2: Create CLAUDE.md**

```markdown
# CLAUDE.md

## Development Commands

```bash
npm run build          # TypeScript compilation
npm run dev            # Watch mode
npm run test           # Run tests
npm run test:watch     # Watch mode tests
npm run lint           # ESLint with strict-type-checked
npm run inspect        # Build + open MCP Inspector in browser
```

## Architecture

Tracemeld is a stateless MCP server for LLM performance profiling.

### Source Layout
- `src/model/` — Canonical data model (`Profile`, `Frame`, `Span`, `Sample`, `Marker`), `ProfileBuilder`, `FrameTable`, `ProfilerState`
- `src/instrument/` — `trace` (begin/end spans) and `mark` (instant markers) tool handlers
- `src/analysis/` — Analysis tools (profile_summary, hotspots, explain_span, etc.)
- `src/importers/` — Format importers (pprof, collapsed, chrome-trace, gecko, speedscope)
- `src/exporters/` — Format exporters
- `src/patterns/` — Anti-pattern detection heuristics
- `src/server.ts` — MCP server setup and tool registration

### Conventions
- All tool handlers are pure functions: `(state: ProfilerState, input: T) => Result`
- Tests mirror source: `src/model/foo.test.ts` tests `src/model/foo.ts`
- Frame names use `{kind}:{detail}` convention (e.g. `bash:npm test`, `file_read:src/auth.ts`)
- Spans reference frames by index into a deduplicated `FrameTable`
- Multi-dimensional values are aligned to `Profile.value_types[]`

### Design Spec
Full specification: `design.md`
```

- [ ] **Step 3: Build and run full verification**

Run: `npx tsc && npx vitest run && npx eslint src/`
Expected: Build succeeds, all tests pass, no lint errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts CLAUDE.md
git commit -m "feat: add public exports and CLAUDE.md"
```

---

## Summary

After completing all 8 tasks, you will have:

- **Canonical data model** — `Profile`, `Frame`, `Lane`, `Span`, `Sample`, `Marker`, `ValueType` types
- **Frame deduplication** — `FrameTable` with `getOrInsert()` by (name, file, line, col, category)
- **Profile construction** — `ProfileBuilder` for creating/mutating profiles
- **Server state** — `ProfilerState` with span stacks, ID generation, pattern cache
- **Instrument tools** — `trace` (begin/end spans with nesting, cost, errors) and `mark` (instant markers)
- **Working MCP server** — responds to stdio, registers both tools, tested end-to-end

**Next plan:** Analysis tools (`profile_summary`, `hotspots`, `explain_span`).
