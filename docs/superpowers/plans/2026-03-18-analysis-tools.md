# Analysis Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `profile_summary`, `hotspots`, and `explain_span` analysis tools so an LLM can understand where time and cost went after instrumenting a session.

**Architecture:** Analysis functions are pure queries over a `Profile` — `(profile: Profile, input) => Result`. Shared traversal utilities (`getSpanById`, `getSpanAncestry`, `computeSelfCost`) live in `query.ts`. Each tool handler bridges `ProfilerState` to the pure query function and is registered in `server.ts`. Anti-pattern detection is deferred to Plan 3 — analysis tools return empty pattern arrays for now.

**Tech Stack:** TypeScript 5, MCP SDK, Zod 4, Vitest.

**Scope note:** Plan 2 of ~4. Covers the Notice → Locate → Diagnose reasoning chain. `find_waste`, `token_flow`, and `compare` are deferred to Plan 3+ (they depend on anti-pattern detection or multi-profile state).

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/analysis/query.ts` | Shared traversal utilities: span lookup, ancestry, self-cost, kind extraction, time filtering |
| `src/analysis/summary.ts` | `profileSummary()` — headline numbers grouped by kind/turn/lane |
| `src/analysis/hotspots.ts` | `findHotspots()` — ranked spans by any cost dimension |
| `src/analysis/explain.ts` | `explainSpan()` — deep-dive into one span with children and causal chain |
| `src/server.ts` | Modified — register 3 new tools |

Test files: `src/analysis/query.test.ts`, `src/analysis/summary.test.ts`, `src/analysis/hotspots.test.ts`, `src/analysis/explain.test.ts`.

---

### Task 1: Shared Query Utilities

**Files:**
- Create: `src/analysis/query.ts`
- Test: `src/analysis/query.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/query.test.ts
import { describe, it, expect } from 'vitest';
import { ProfileBuilder } from '../model/profile.js';
import { handleTrace } from '../instrument/trace.js';
import { ProfilerState } from '../model/state.js';
import {
  getSpanById,
  getSpanAncestry,
  computeSelfCost,
  extractKind,
  filterSpansByTimeRange,
  getAllSpans,
} from './query.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  // session
  //   turn:1
  //     bash:npm test (wall_ms=5000, input_tokens=100)
  //     file_read:src/auth.ts (wall_ms=200, input_tokens=3000)
  //   turn:2
  //     thinking:planning (wall_ms=1000, input_tokens=500)
  handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000, input_tokens: 100 } });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
  handleTrace(state, { action: 'begin', kind: 'thinking', name: 'planning' });
  handleTrace(state, { action: 'end', kind: 'thinking', cost: { wall_ms: 1000, input_tokens: 500 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('getAllSpans', () => {
  it('collects spans from all lanes', () => {
    const state = buildTestProfile();
    const spans = getAllSpans(state.builder.profile);
    // session, turn:1, bash, file_read, turn:2, thinking = 6 spans
    expect(spans.length).toBe(6);
  });
});

describe('getSpanById', () => {
  it('finds a span by id', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const first = allSpans[0];
    const found = getSpanById(state.builder.profile, first.id);
    expect(found).toBe(first);
  });

  it('returns undefined for unknown id', () => {
    const state = buildTestProfile();
    expect(getSpanById(state.builder.profile, 'nonexistent')).toBeUndefined();
  });
});

describe('getSpanAncestry', () => {
  it('returns frame names from root to span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    // bash:npm test is child of turn:1, which is child of session:test
    const bashSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'bash:npm test'
    );
    if (!bashSpan) throw new Error('bash span not found');
    const ancestry = getSpanAncestry(profile, bashSpan);
    expect(ancestry).toEqual(['session:test', 'turn:1', 'bash:npm test']);
  });

  it('returns single element for root span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const sessionSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'session:test'
    );
    if (!sessionSpan) throw new Error('session span not found');
    const ancestry = getSpanAncestry(profile, sessionSpan);
    expect(ancestry).toEqual(['session:test']);
  });
});

describe('computeSelfCost', () => {
  it('clamps self cost to zero when parent has no explicit cost', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    // turn:1 has children bash (wall_ms=5000) and file_read (wall_ms=200)
    // turn:1 itself has no explicit cost (values are all zeros from emptyValues())
    // So self cost = max(0, 0 - 5000 - 200) = 0 (clamped)
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');
    const selfCost = computeSelfCost(profile, turnSpan);
    expect(selfCost[0]).toBe(0); // clamped to 0
    expect(selfCost[1]).toBe(0); // clamped to 0
  });

  it('returns values directly for leaf span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const bashSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'bash:npm test'
    );
    if (!bashSpan) throw new Error('bash span not found');
    const selfCost = computeSelfCost(profile, bashSpan);
    expect(selfCost).toEqual(bashSpan.values);
  });
});

describe('extractKind', () => {
  it('extracts kind from kind:detail format', () => {
    expect(extractKind('bash:npm test')).toBe('bash');
  });

  it('returns the full name when no colon', () => {
    expect(extractKind('thinking')).toBe('thinking');
  });
});

describe('filterSpansByTimeRange', () => {
  it('filters spans within time range', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const min = Math.min(...allSpans.map((s) => s.start_time));
    const max = Math.max(...allSpans.map((s) => s.end_time));
    const mid = Math.floor((min + max) / 2);
    const filtered = filterSpansByTimeRange(allSpans, { start_ms: mid, end_ms: max });
    // All spans that overlap with [mid, max]
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(allSpans.length);
  });

  it('returns all spans when no range given', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const filtered = filterSpansByTimeRange(allSpans, undefined);
    expect(filtered.length).toBe(allSpans.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/analysis/query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/query.ts
import type { Profile, Span } from '../model/types.js';

export interface TimeRange {
  start_ms: number;
  end_ms: number;
}

/** Collect all spans from all lanes. */
export function getAllSpans(profile: Profile): Span[] {
  const spans: Span[] = [];
  for (const lane of profile.lanes) {
    for (const span of lane.spans) {
      spans.push(span);
    }
  }
  return spans;
}

/** Find a span by ID across all lanes. */
export function getSpanById(profile: Profile, spanId: string): Span | undefined {
  for (const lane of profile.lanes) {
    const span = lane.spans.find((s) => s.id === spanId);
    if (span) return span;
  }
  return undefined;
}

/** Get the ancestry chain as frame names, from root to the given span. */
export function getSpanAncestry(profile: Profile, span: Span): string[] {
  const chain: string[] = [];
  let current: Span | undefined = span;

  while (current) {
    const frame = profile.frames[current.frame_index];
    chain.push(frame?.name ?? `<unknown frame ${current.frame_index}>`);
    if (current.parent_id) {
      current = getSpanById(profile, current.parent_id);
    } else {
      current = undefined;
    }
  }

  chain.reverse();
  return chain;
}

/**
 * Compute self-cost: span's values minus the sum of direct children's values.
 * Returns a new array aligned to profile.value_types.
 */
export function computeSelfCost(profile: Profile, span: Span): number[] {
  if (span.children.length === 0) {
    return [...span.values];
  }

  const selfCost = [...span.values];
  for (const childId of span.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;
    for (let i = 0; i < selfCost.length; i++) {
      selfCost[i] -= child.values[i] ?? 0;
    }
  }

  // Clamp negative values to 0 (can happen due to timing imprecision)
  for (let i = 0; i < selfCost.length; i++) {
    if (selfCost[i] < 0) selfCost[i] = 0;
  }

  return selfCost;
}

/** Extract the kind prefix from a frame name. "bash:npm test" → "bash". */
export function extractKind(frameName: string): string {
  const colonIdx = frameName.indexOf(':');
  return colonIdx >= 0 ? frameName.substring(0, colonIdx) : frameName;
}

/** Filter spans that overlap with a time range. Returns all if range is undefined. */
export function filterSpansByTimeRange(
  spans: Span[],
  range: TimeRange | undefined,
): Span[] {
  if (!range) return spans;
  return spans.filter(
    (s) => s.end_time >= range.start_ms && s.start_time <= range.end_ms,
  );
}

/** Convert a span's values array to a Record keyed by value_type.key. */
export function valuesToRecord(
  profile: Profile,
  values: number[],
): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < profile.value_types.length; i++) {
    record[profile.value_types[i].key] = values[i] ?? 0;
  }
  return record;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/analysis/query.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Lint**

Run: `npx eslint src/analysis/query.ts src/analysis/query.test.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/query.ts src/analysis/query.test.ts
git commit -m "feat: add shared analysis query utilities"
```

---

### Task 2: profile_summary Tool

**Files:**
- Create: `src/analysis/summary.ts`
- Test: `src/analysis/summary.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/summary.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { profileSummary } from './summary.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000, input_tokens: 100 } });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm lint' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 2000, input_tokens: 50 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('profileSummary', () => {
  it('returns totals across all spans', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, {});
    expect(result.span_count).toBe(6);
    expect(result.error_count).toBe(0);
    // Totals sum leaf span costs (only spans with explicit cost)
    expect(result.totals['wall_ms']).toBeGreaterThan(0);
  });

  it('groups by kind', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'kind' });
    const bashGroup = result.groups.find((g) => g.key === 'bash');
    expect(bashGroup).toBeDefined();
    if (!bashGroup) throw new Error('bash group not found');
    expect(bashGroup.span_count).toBe(2); // npm test + npm lint
    expect(bashGroup.totals['wall_ms']).toBe(7000); // 5000 + 2000
  });

  it('groups by lane', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'lane' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].key).toBe('main');
  });

  it('computes pct_of_total', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'kind' });
    const bashGroup = result.groups.find((g) => g.key === 'bash');
    if (!bashGroup) throw new Error('bash group not found');
    // bash wall_ms should be a percentage of total wall_ms
    expect(bashGroup.pct_of_total['wall_ms']).toBeGreaterThan(0);
    expect(bashGroup.pct_of_total['wall_ms']).toBeLessThanOrEqual(100);
  });

  it('flags groups exceeding 40% for investigation', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'kind' });
    // bash has 7000/7200 wall_ms ≈ 97% — should trigger investigate
    const bashGroup = result.groups.find((g) => g.key === 'bash');
    if (!bashGroup) throw new Error('bash group not found');
    expect(bashGroup.investigate).toBeDefined();
    if (!bashGroup.investigate) throw new Error('investigate not set');
    expect(bashGroup.investigate.pct).toBeGreaterThan(40);
  });

  it('counts errors', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit code 1', cost: { wall_ms: 100 } });
    const result = profileSummary(state.builder.profile, {});
    expect(result.error_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/analysis/summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/summary.ts
import type { Profile, Span } from '../model/types.js';
import {
  getAllSpans,
  getSpanById,
  extractKind,
  filterSpansByTimeRange,
  valuesToRecord,
  computeSelfCost,
  type TimeRange,
} from './query.js';

export interface ProfileSummaryInput {
  group_by?: 'kind' | 'turn' | 'lane';
  time_range?: TimeRange;
}

export interface ProfileGroupResult {
  key: string;
  totals: Record<string, number>;
  pct_of_total: Record<string, number>;
  span_count: number;
  error_count: number;
  investigate?: {
    dimension: string;
    pct: number;
    hint: string;
  };
}

export interface ProfileSummaryResult {
  totals: Record<string, number>;
  groups: ProfileGroupResult[];
  span_count: number;
  error_count: number;
  wall_duration_ms: number;
  active_duration_ms: number;
}

export function profileSummary(
  profile: Profile,
  input: ProfileSummaryInput,
): ProfileSummaryResult {
  const groupBy = input.group_by ?? 'kind';
  const allSpans = getAllSpans(profile);
  const spans = filterSpansByTimeRange(allSpans, input.time_range);

  // Compute totals using self-cost (avoids double-counting parent+child values).
  // Parent spans created by handleTrace have zero values unless explicit cost was
  // passed on end, so summing raw values works for the instrumentation use case.
  // For imported profiles with parent-level costs, use computeSelfCost instead.
  const totalValues = new Array<number>(profile.value_types.length).fill(0);
  let errorCount = 0;

  for (const span of spans) {
    const selfCost = computeSelfCost(profile, span);
    for (let i = 0; i < totalValues.length; i++) {
      totalValues[i] += selfCost[i] ?? 0;
    }
    if (span.error) errorCount++;
  }

  const totals = valuesToRecord(profile, totalValues);

  // Group spans
  const groups = new Map<string, { values: number[]; spanCount: number; errorCount: number }>();

  for (const span of spans) {
    const key = getGroupKey(profile, span, groupBy);
    let group = groups.get(key);
    if (!group) {
      group = {
        values: new Array<number>(profile.value_types.length).fill(0),
        spanCount: 0,
        errorCount: 0,
      };
      groups.set(key, group);
    }
    const spanSelfCost = computeSelfCost(profile, span);
    for (let i = 0; i < group.values.length; i++) {
      group.values[i] += spanSelfCost[i] ?? 0;
    }
    group.spanCount++;
    if (span.error) group.errorCount++;
  }

  // Build group results with percentages and investigation flags
  const groupResults: ProfileGroupResult[] = [];
  for (const [key, group] of groups) {
    const groupTotals = valuesToRecord(profile, group.values);
    const pctOfTotal: Record<string, number> = {};

    let maxPct = 0;
    let maxDimension = '';

    for (let i = 0; i < profile.value_types.length; i++) {
      const vtKey = profile.value_types[i].key;
      const pct = totalValues[i] > 0 ? (group.values[i] / totalValues[i]) * 100 : 0;
      pctOfTotal[vtKey] = Math.round(pct * 100) / 100;
      if (pct > maxPct) {
        maxPct = pct;
        maxDimension = vtKey;
      }
    }

    const result: ProfileGroupResult = {
      key,
      totals: groupTotals,
      pct_of_total: pctOfTotal,
      span_count: group.spanCount,
      error_count: group.errorCount,
    };

    if (maxPct > 40) {
      result.investigate = {
        dimension: maxDimension,
        pct: Math.round(maxPct * 100) / 100,
        hint: `${Math.round(maxPct)}% of ${maxDimension} — call hotspots with dimension='${maxDimension}'`,
      };
    }

    groupResults.push(result);
  }

  // Sort groups by highest total across any dimension (descending)
  groupResults.sort((a, b) => {
    const aMax = Math.max(...Object.values(a.totals));
    const bMax = Math.max(...Object.values(b.totals));
    return bMax - aMax;
  });

  // Compute wall duration and active duration
  let minStart = Infinity;
  let maxEnd = 0;
  let idleDuration = 0;

  for (const span of spans) {
    if (span.start_time < minStart) minStart = span.start_time;
    if (span.end_time > maxEnd) maxEnd = span.end_time;
    const frameName = profile.frames[span.frame_index]?.name ?? '';
    if (frameName.startsWith('user_input:')) {
      idleDuration += span.end_time - span.start_time;
    }
  }

  const wallDuration = spans.length > 0 ? maxEnd - minStart : 0;

  return {
    totals,
    groups: groupResults,
    span_count: spans.length,
    error_count: errorCount,
    wall_duration_ms: wallDuration,
    active_duration_ms: wallDuration - idleDuration,
  };
}

function getGroupKey(profile: Profile, span: Span, groupBy: string): string {
  const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
  switch (groupBy) {
    case 'kind':
      return extractKind(frameName);
    case 'turn': {
      let current: Span | undefined = span;
      while (current) {
        const name = profile.frames[current.frame_index]?.name ?? '';
        if (name.startsWith('turn:')) return name;
        if (!current.parent_id) break;
        current = getSpanById(profile, current.parent_id);
      }
      return 'no-turn';
    }
    case 'lane': {
      for (const lane of profile.lanes) {
        if (lane.spans.some((s) => s.id === span.id)) return lane.name;
      }
      return 'unknown';
    }
    default:
      return extractKind(frameName);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/analysis/summary.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Lint**

Run: `npx eslint src/analysis/summary.ts src/analysis/summary.test.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/summary.ts src/analysis/summary.test.ts
git commit -m "feat: add profile_summary analysis tool"
```

---

### Task 3: hotspots Tool

**Files:**
- Create: `src/analysis/hotspots.ts`
- Test: `src/analysis/hotspots.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/hotspots.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findHotspots } from './hotspots.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000, input_tokens: 100 } });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('findHotspots', () => {
  it('ranks spans by self cost on the given dimension', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.dimension).toBe('wall_ms');
    expect(result.entries.length).toBeGreaterThan(0);
    // bash:npm test has highest self wall_ms (5000)
    expect(result.entries[0].name).toBe('bash:npm test');
  });

  it('ranks by input_tokens when requested', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'input_tokens' });
    // file_read has highest self input_tokens (3000)
    expect(result.entries[0].name).toBe('file_read:src/auth.ts');
  });

  it('respects top_n limit', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms', top_n: 2 });
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  it('includes ancestry chain', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms', top_n: 1 });
    const entry = result.entries[0];
    expect(entry.ancestry).toContain('session:test');
    expect(entry.ancestry).toContain('turn:1');
    expect(entry.ancestry).toContain('bash:npm test');
  });

  it('includes total_cost and self_cost', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms', top_n: 1 });
    const entry = result.entries[0];
    expect(entry.total_cost['wall_ms']).toBe(5000);
    expect(entry.self_cost['wall_ms']).toBe(5000); // leaf node, self = total
  });

  it('includes pct_of_total', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms' });
    const entry = result.entries[0];
    expect(entry.pct_of_total).toBeGreaterThan(0);
    expect(entry.pct_of_total).toBeLessThanOrEqual(100);
  });

  it('includes investigate breadcrumb', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'wall_ms', top_n: 1 });
    expect(result.entries[0].investigate).toContain('explain_span');
  });

  it('filters by min_value', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, {
      dimension: 'wall_ms',
      min_value: 1000,
    });
    for (const entry of result.entries) {
      expect(entry.self_cost['wall_ms']).toBeGreaterThanOrEqual(1000);
    }
  });

  it('ranks by error count when dimension is "errors"', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'fail' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit 1', cost: { wall_ms: 100 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'ok' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 200 } });
    const result = findHotspots(state.builder.profile, { dimension: 'errors' });
    expect(result.entries[0].name).toBe('bash:fail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/analysis/hotspots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/hotspots.ts
import type { Profile, Span, DetectedPattern } from '../model/types.js';
import {
  getAllSpans,
  getSpanAncestry,
  computeSelfCost,
  valuesToRecord,
} from './query.js';

export interface HotspotsInput {
  dimension: string;
  top_n?: number;
  min_value?: number;
}

export interface HotspotEntry {
  span_id: string;
  ancestry: string[];
  name: string;
  total_cost: Record<string, number>;
  self_cost: Record<string, number>;
  pct_of_total: number;
  patterns: DetectedPattern[];
  investigate: string;
}

export interface HotspotsResult {
  dimension: string;
  entries: HotspotEntry[];
}

export function findHotspots(profile: Profile, input: HotspotsInput): HotspotsResult {
  const topN = input.top_n ?? 10;
  const minValue = input.min_value ?? 0;
  const dim = input.dimension;
  const isErrors = dim === 'errors';
  const spans = getAllSpans(profile);

  // Find dimension index
  const dimIndex = isErrors ? -1 : profile.value_types.findIndex((vt) => vt.key === dim);

  // Compute self cost for each span + rank value
  const ranked: Array<{ span: Span; selfCost: number[]; rankValue: number }> = [];

  for (const span of spans) {
    const selfCost = computeSelfCost(profile, span);
    let rankValue: number;

    if (isErrors) {
      rankValue = countSubtreeErrors(profile, span, spans);
    } else if (dimIndex >= 0) {
      rankValue = selfCost[dimIndex] ?? 0;
    } else {
      rankValue = 0;
    }

    if (rankValue >= minValue) {
      ranked.push({ span, selfCost, rankValue });
    }
  }

  // Sort descending by rank value
  ranked.sort((a, b) => b.rankValue - a.rankValue);

  // Compute total for the dimension (for pct_of_total)
  let dimensionTotal = 0;
  if (isErrors) {
    for (const span of spans) {
      if (span.error) dimensionTotal++;
    }
  } else if (dimIndex >= 0) {
    for (const span of spans) {
      const selfCost = computeSelfCost(profile, span);
      dimensionTotal += selfCost[dimIndex] ?? 0;
    }
  }

  // Build entries
  const entries: HotspotEntry[] = [];
  for (const item of ranked.slice(0, topN)) {
    const frameName = profile.frames[item.span.frame_index]?.name ?? '<unknown>';
    const pctOfTotal = dimensionTotal > 0
      ? Math.round((item.rankValue / dimensionTotal) * 10000) / 100
      : 0;

    entries.push({
      span_id: item.span.id,
      ancestry: getSpanAncestry(profile, item.span),
      name: frameName,
      total_cost: valuesToRecord(profile, item.span.values),
      self_cost: valuesToRecord(profile, item.selfCost),
      pct_of_total: pctOfTotal,
      patterns: [], // Populated by anti-pattern engine in Plan 3
      investigate: `call explain_span with span_id '${item.span.id}' to see the breakdown`,
    });
  }

  return { dimension: dim, entries };
}

function countSubtreeErrors(profile: Profile, span: Span, allSpans: Span[]): number {
  let count = span.error ? 1 : 0;
  for (const childId of span.children) {
    const child = allSpans.find((s) => s.id === childId);
    if (child) count += countSubtreeErrors(profile, child, allSpans);
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/analysis/hotspots.test.ts`
Expected: All 9 tests PASS.

- [ ] **Step 5: Lint**

Run: `npx eslint src/analysis/hotspots.ts src/analysis/hotspots.test.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/hotspots.ts src/analysis/hotspots.test.ts
git commit -m "feat: add hotspots analysis tool"
```

---

### Task 4: explain_span Tool

**Files:**
- Create: `src/analysis/explain.ts`
- Test: `src/analysis/explain.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/explain.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { handleMark } from '../instrument/mark.js';
import { explainSpan } from './explain.js';
import { getAllSpans } from './query.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  handleTrace(state, { action: 'begin', kind: 'session', name: 'refactor' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, {
    action: 'end',
    kind: 'file_read',
    cost: { wall_ms: 200, input_tokens: 3000 },
  });
  handleMark(state, { what: 'found auth issue', severity: 'info' });
  handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
  handleTrace(state, {
    action: 'end',
    kind: 'file_write',
    cost: { wall_ms: 500, output_tokens: 800 },
  });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, {
    action: 'end',
    kind: 'bash',
    cost: { wall_ms: 5000 },
    error: 'exit code 1',
  });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('explainSpan', () => {
  it('returns span details', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.span.name).toBe('turn:1');
    expect(result.span.kind).toBe('turn');
    expect(result.span.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns ancestry chain', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.ancestry).toEqual(['session:refactor', 'turn:1']);
  });

  it('returns children sorted by cost', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.children.length).toBe(3); // file_read, file_write, bash
    // First child should be highest cost (bash: 5000 wall_ms)
    expect(result.children[0].name).toBe('bash:npm test');
  });

  it('includes pct_of_parent on children', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    // All children should have pct_of_parent values
    for (const child of result.children) {
      expect(child.pct_of_parent['wall_ms']).toBeDefined();
    }
  });

  it('builds causal chain in chronological order', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.causal_chain.length).toBeGreaterThanOrEqual(3);
    // Verify chronological order
    for (let i = 1; i < result.causal_chain.length; i++) {
      expect(result.causal_chain[i].timestamp).toBeGreaterThanOrEqual(
        result.causal_chain[i - 1].timestamp,
      );
    }
  });

  it('includes markers in causal chain', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    const markerEvent = result.causal_chain.find((e) => e.kind === 'marker');
    expect(markerEvent).toBeDefined();
    if (!markerEvent) throw new Error('marker event not found');
    expect(markerEvent.event).toContain('found auth issue');
  });

  it('flags children with errors', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    const bashChild = result.children.find((c) => c.name === 'bash:npm test');
    expect(bashChild?.error).toBe('exit code 1');
  });

  it('returns error for unknown span_id', () => {
    const state = buildTestProfile();
    const result = explainSpan(state.builder.profile, { span_id: 'nonexistent' });
    expect(result.span.name).toBe('<not found>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/analysis/explain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/explain.ts
import type { Profile, Span, Marker, DetectedPattern } from '../model/types.js';
import {
  getSpanById,
  getSpanAncestry,
  computeSelfCost,
  extractKind,
  valuesToRecord,
} from './query.js';

export interface ExplainSpanInput {
  span_id: string;
}

export interface ExplainSpanResult {
  span: {
    name: string;
    kind: string;
    start_time: number;
    end_time: number;
    duration_ms: number;
    cost: Record<string, number>;
    error?: string;
    args: Record<string, unknown>;
  };
  ancestry: string[];
  children: Array<{
    span_id: string;
    name: string;
    cost: Record<string, number>;
    pct_of_parent: Record<string, number>;
    error?: string;
  }>;
  causal_chain: Array<{
    timestamp: number;
    event: string;
    kind: string;
    cost: Record<string, number>;
    outcome?: string;
  }>;
  patterns: DetectedPattern[];
  recommendations: string[];
}

export function explainSpan(profile: Profile, input: ExplainSpanInput): ExplainSpanResult {
  const span = getSpanById(profile, input.span_id);

  if (!span) {
    return notFoundResult();
  }

  const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
  const kind = extractKind(frameName);
  const ancestry = getSpanAncestry(profile, span);
  const cost = valuesToRecord(profile, span.values);

  // Build children list sorted by largest cost dimension (first value type)
  const children = buildChildren(profile, span);

  // Build causal chain from children + markers
  const causalChain = buildCausalChain(profile, span);

  return {
    span: {
      name: frameName,
      kind,
      start_time: span.start_time,
      end_time: span.end_time,
      duration_ms: span.end_time - span.start_time,
      cost,
      error: span.error,
      args: span.args,
    },
    ancestry,
    children,
    causal_chain: causalChain,
    patterns: [], // Populated by anti-pattern engine in Plan 3
    recommendations: [], // Populated by anti-pattern engine in Plan 3
  };
}

function buildChildren(
  profile: Profile,
  parent: Span,
): ExplainSpanResult['children'] {
  const children: ExplainSpanResult['children'] = [];

  for (const childId of parent.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;

    const childName = profile.frames[child.frame_index]?.name ?? '<unknown>';
    const childCost = valuesToRecord(profile, child.values);

    // Compute pct_of_parent
    const pctOfParent: Record<string, number> = {};
    for (let i = 0; i < profile.value_types.length; i++) {
      const key = profile.value_types[i].key;
      const parentVal = parent.values[i] ?? 0;
      const childVal = child.values[i] ?? 0;
      pctOfParent[key] =
        parentVal > 0 ? Math.round((childVal / parentVal) * 10000) / 100 : 0;
    }

    children.push({
      span_id: child.id,
      name: childName,
      cost: childCost,
      pct_of_parent: pctOfParent,
      error: child.error,
    });
  }

  // Sort by the first value type dimension (typically wall_ms), descending
  children.sort((a, b) => {
    const key = profile.value_types[0]?.key;
    if (!key) return 0;
    return (b.cost[key] ?? 0) - (a.cost[key] ?? 0);
  });

  return children;
}

function buildCausalChain(
  profile: Profile,
  parent: Span,
): ExplainSpanResult['causal_chain'] {
  const events: ExplainSpanResult['causal_chain'] = [];

  // Add child spans
  for (const childId of parent.children) {
    const child = getSpanById(profile, childId);
    if (!child) continue;

    const childName = profile.frames[child.frame_index]?.name ?? '<unknown>';
    const childKind = extractKind(childName);
    const childCost = valuesToRecord(profile, child.values);

    let eventDesc = childName;
    const duration = child.end_time - child.start_time;
    if (duration > 0) {
      eventDesc += ` (${formatDuration(duration)}`;
      // Add token info if present
      const inputTokens = child.values[profile.value_types.findIndex((vt) => vt.key === 'input_tokens')] ?? 0;
      if (inputTokens > 0) eventDesc += `, ${inputTokens} tokens`;
      eventDesc += ')';
    }
    if (child.error) eventDesc += ` [ERROR: ${child.error}]`;

    events.push({
      timestamp: child.start_time,
      event: eventDesc,
      kind: childKind,
      cost: childCost,
    });
  }

  // Add markers that fall within the parent's time range
  for (const lane of profile.lanes) {
    for (const marker of lane.markers) {
      if (marker.timestamp >= parent.start_time && marker.timestamp <= parent.end_time) {
        events.push({
          timestamp: marker.timestamp,
          event: marker.name,
          kind: 'marker',
          cost: {},
        });
      }
    }
  }

  // Sort chronologically
  events.sort((a, b) => a.timestamp - b.timestamp);

  return events;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function notFoundResult(): ExplainSpanResult {
  return {
    span: {
      name: '<not found>',
      kind: 'unknown',
      start_time: 0,
      end_time: 0,
      duration_ms: 0,
      cost: {},
      args: {},
    },
    ancestry: [],
    children: [],
    causal_chain: [],
    patterns: [],
    recommendations: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/analysis/explain.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Lint**

Run: `npx eslint src/analysis/explain.ts src/analysis/explain.test.ts`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/explain.ts src/analysis/explain.test.ts
git commit -m "feat: add explain_span analysis tool"
```

---

### Task 5: Wire Analysis Tools into MCP Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts` (add integration tests)

- [ ] **Step 1: Write the failing tests**

The existing `src/server.test.ts` from Plan 1 already has `createTestClient()`, `parseToolResult()`, `afterEach` cleanup, and the `describe('MCP Server', ...)` block. Append these tests inside the existing `describe` block:

```typescript
// Append inside the existing describe('MCP Server', ...) block in src/server.test.ts

it('profile_summary returns totals and groups', async () => {
  const c = await createTestClient();
  // Instrument some spans first
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });

  const result = await c.callTool({
    name: 'profile_summary',
    arguments: { group_by: 'kind' },
  });
  const parsed = parseToolResult(result) as { span_count: number; groups: Array<{ key: string }> };
  expect(parsed.span_count).toBeGreaterThan(0);
  expect(parsed.groups.length).toBeGreaterThan(0);
});

it('hotspots returns ranked entries', async () => {
  const c = await createTestClient();
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });

  const result = await c.callTool({
    name: 'hotspots',
    arguments: { dimension: 'wall_ms', top_n: 5 },
  });
  const parsed = parseToolResult(result) as { entries: Array<{ name: string }> };
  expect(parsed.entries.length).toBeGreaterThan(0);
});

it('explain_span returns span details', async () => {
  const c = await createTestClient();
  const traceResult = await c.callTool({
    name: 'trace',
    arguments: { action: 'begin', kind: 'bash', name: 'npm test' },
  });
  const traceData = parseToolResult(traceResult) as { span_id: string };
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } } });

  const result = await c.callTool({
    name: 'explain_span',
    arguments: { span_id: traceData.span_id },
  });
  const parsed = parseToolResult(result) as { span: { name: string } };
  expect(parsed.span.name).toBe('bash:npm test');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Register analysis tools in server.ts**

Add imports at top of `src/server.ts`:

```typescript
import { profileSummary } from './analysis/summary.js';
import { findHotspots } from './analysis/hotspots.js';
import { explainSpan } from './analysis/explain.js';
```

Add tool registrations after the existing `mark` tool:

```typescript
server.registerTool(
  'profile_summary',
  {
    description:
      'Get headline performance numbers for a session: total time, tokens, cost, errors. Group by turn, operation kind, or execution lane to see where effort concentrated. Start here when you want to understand how a session went.',
    inputSchema: {
      group_by: z.enum(['kind', 'turn', 'lane']).optional(),
      time_range: z
        .object({
          start_ms: z.number(),
          end_ms: z.number(),
        })
        .optional(),
    },
  },
  (args) => {
    const result = profileSummary(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'hotspots',
  {
    description:
      'Find the most expensive operations by any dimension: wall time, tokens consumed, tokens generated, dollar cost, or error count. Returns a ranked list with ancestry chains. Use after profile_summary identifies a concentration of cost.',
    inputSchema: {
      dimension: z.string(),
      top_n: z.number().optional(),
      min_value: z.number().optional(),
    },
  },
  (args) => {
    const result = findHotspots(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'explain_span',
  {
    description:
      "Deep-dive into one expensive span. Shows its child breakdown, the causal chain of what happened, and any detected anti-patterns. Use when hotspots identified a specific span to investigate.",
    inputSchema: {
      span_id: z.string(),
    },
  },
  (args) => {
    const result = explainSpan(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server.test.ts`
Expected: All 7 tests PASS (4 existing + 3 new).

- [ ] **Step 5: Run full test suite and lint**

Run: `npx vitest run && npx eslint src/`
Expected: All tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: wire profile_summary, hotspots, explain_span into MCP server"
```

---

## Summary

After completing all 5 tasks, the tracemeld MCP server will have:

- **Shared query utilities** — span lookup, ancestry chain, self-cost computation, kind extraction, time filtering, values-to-record conversion
- **profile_summary** — headline numbers grouped by kind/turn/lane with investigation breadcrumbs
- **hotspots** — ranked spans by any cost dimension with ancestry chains and investigate hints
- **explain_span** — deep-dive with children, pct_of_parent, causal chain including markers, error flagging
- **5 MCP tools total** — trace, mark, profile_summary, hotspots, explain_span

Anti-pattern detection (`patterns` and `recommendations` fields) returns empty arrays — populated in Plan 3.

**Next plan:** Anti-pattern detection engine + `find_waste` tool.
