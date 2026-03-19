# Advanced Analysis Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 advanced analysis tools — `hotpaths`, `bottleneck`, `spinpaths`, `starvations` — that go beyond flat ranking to provide structural performance insights: critical paths, optimization targets, busy-wait detection, and thread starvation.

**Architecture:** Each tool is a pure query function `(profile: Profile, input) => Result` in `src/analysis/`. They build on the existing query utilities (getAllSpans, getSpanById, computeSelfCost, getSpanAncestry, valuesToRecord) and add new traversal algorithms: weighted path extraction (hotpaths), bottleneck scoring (self-cost × path criticality), activity ratio analysis (spinpaths), and multi-lane gap detection (starvations). All are registered as MCP tools in server.ts.

**Tech Stack:** TypeScript 5, MCP SDK, Zod 4, Vitest.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/analysis/hotpaths.ts` | Find the critical call paths that account for the most cost |
| `src/analysis/bottleneck.ts` | Find spans where optimization would move the needle most |
| `src/analysis/spinpaths.ts` | Detect paths with high wall time but low useful work |
| `src/analysis/starvations.ts` | Detect lanes idle while others are busy |
| `src/server.ts` | Modified — register 4 new tools |

Tests mirror source.

---

### Task 1: hotpaths Tool

The critical path from root to the heaviest leaf — "what call chain accounts for the most time?" Unlike hotspots (flat ranking), this shows the full path structure.

**Files:**
- Create: `src/analysis/hotpaths.ts`
- Test: `src/analysis/hotpaths.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/hotpaths.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findHotpaths } from './hotpaths.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  // session
  //   turn:1
  //     bash:npm test (wall_ms=5000)  ← hot path
  //     file_read:src/auth.ts (wall_ms=200)
  //   turn:2
  //     thinking:planning (wall_ms=1000)
  handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
  handleTrace(state, { action: 'begin', kind: 'thinking', name: 'planning' });
  handleTrace(state, { action: 'end', kind: 'thinking', cost: { wall_ms: 1000 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('findHotpaths', () => {
  it('returns the heaviest root-to-leaf path', () => {
    const state = buildTestProfile();
    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.paths.length).toBeGreaterThan(0);
    const topPath = result.paths[0];
    // The hottest path is session→turn:1→bash:npm test (5000ms)
    expect(topPath.frames[topPath.frames.length - 1]).toBe('bash:npm test');
    expect(topPath.leaf_cost).toBe(5000);
  });

  it('returns multiple paths ranked by cost', () => {
    const state = buildTestProfile();
    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms', top_n: 3 });
    expect(result.paths.length).toBeLessThanOrEqual(3);
    // First should be more expensive than second
    if (result.paths.length >= 2) {
      expect(result.paths[0].leaf_cost).toBeGreaterThanOrEqual(result.paths[1].leaf_cost);
    }
  });

  it('includes percentage of total', () => {
    const state = buildTestProfile();
    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms', top_n: 1 });
    expect(result.paths[0].pct_of_total).toBeGreaterThan(0);
    expect(result.paths[0].pct_of_total).toBeLessThanOrEqual(100);
  });

  it('works with sample-based profiles', () => {
    const { importCollapsed } = require('../importers/collapsed.js') as typeof import('../importers/collapsed.js');
    const imported = importCollapsed('a;b;c 50\na;b;d 30\na;e 20\n', 'test.txt');
    const result = findHotpaths(imported.profile, { dimension: 'weight' });
    expect(result.paths[0].frames).toEqual(['a', 'b', 'c']);
    expect(result.paths[0].leaf_cost).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/hotpaths.ts
import type { Profile, Span } from '../model/types.js';
import { getAllSpans, getSpanAncestry, computeSelfCost, valuesToRecord } from './query.js';

export interface HotpathsInput {
  dimension: string;
  top_n?: number;
}

export interface HotpathEntry {
  /** Frame names from root to leaf. */
  frames: string[];
  /** The leaf span/sample's self-cost on the ranked dimension. */
  leaf_cost: number;
  /** Cumulative cost along this path. */
  path_cost: Record<string, number>;
  /** Percentage of total for the ranked dimension. */
  pct_of_total: number;
  /** Span ID of the leaf (null for samples). */
  leaf_span_id: string | null;
}

export interface HotpathsResult {
  dimension: string;
  paths: HotpathEntry[];
}

export function findHotpaths(profile: Profile, input: HotpathsInput): HotpathsResult {
  const topN = input.top_n ?? 10;
  const dim = input.dimension;
  const dimIndex = profile.value_types.findIndex((vt) => vt.key === dim);
  if (dimIndex < 0) {
    return { dimension: dim, paths: [] };
  }

  const entries: HotpathEntry[] = [];

  // From spans: find leaf spans (no children) and trace their ancestry
  const allSpans = getAllSpans(profile);
  let totalCost = 0;

  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span);
    totalCost += selfCost[dimIndex] ?? 0;
  }

  for (const span of allSpans) {
    if (span.children.length > 0) continue; // Only leaf spans
    const selfCost = computeSelfCost(profile, span);
    const leafCost = selfCost[dimIndex] ?? 0;
    if (leafCost <= 0) continue;

    const ancestry = getSpanAncestry(profile, span);

    entries.push({
      frames: ancestry,
      leaf_cost: leafCost,
      path_cost: valuesToRecord(profile, selfCost),
      pct_of_total: totalCost > 0 ? Math.round((leafCost / totalCost) * 10000) / 100 : 0,
      leaf_span_id: span.id,
    });
  }

  // From samples: each sample is already a root-to-leaf path
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      const cost = sample.values[dimIndex] ?? 0;
      if (cost <= 0) continue;
      totalCost += cost; // Add sample costs to total (if not already counted)

      const frames = sample.stack.map((idx) => profile.frames[idx]?.name ?? '<unknown>');
      entries.push({
        frames,
        leaf_cost: cost,
        path_cost: valuesToRecord(profile, sample.values),
        pct_of_total: 0, // Recalculated below
        leaf_span_id: null,
      });
    }
  }

  // Recalculate pct_of_total with full total (spans + samples)
  const fullTotal = entries.reduce((sum, e) => sum + e.leaf_cost, 0);
  for (const entry of entries) {
    entry.pct_of_total = fullTotal > 0
      ? Math.round((entry.leaf_cost / fullTotal) * 10000) / 100
      : 0;
  }

  // Sort by leaf_cost descending
  entries.sort((a, b) => b.leaf_cost - a.leaf_cost);

  return {
    dimension: dim,
    paths: entries.slice(0, topN),
  };
}
```

- [ ] **Step 4: Run tests, lint, commit**

```bash
npx vitest run src/analysis/hotpaths.test.ts
npx eslint src/analysis/hotpaths.ts src/analysis/hotpaths.test.ts
git add src/analysis/hotpaths.ts src/analysis/hotpaths.test.ts
git commit -m "feat: add hotpaths analysis tool"
```

---

### Task 2: bottleneck Tool

A span that's both on the critical path AND has high self-time — "if you could speed up one thing, what would move the needle most?" Combines self-cost with path criticality.

**Files:**
- Create: `src/analysis/bottleneck.ts`
- Test: `src/analysis/bottleneck.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/bottleneck.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findBottlenecks } from './bottleneck.js';

describe('findBottlenecks', () => {
  it('identifies the span with highest optimization impact', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
    // Path A: session→turn:1→bash:npm test (5000ms self)
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    // Path B: session→turn:2→file_read (200ms self)
    handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'end', kind: 'session' });

    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.entries.length).toBeGreaterThan(0);
    // bash:npm test has the highest self-cost on the critical path
    expect(result.entries[0].name).toBe('bash:npm test');
    expect(result.entries[0].self_cost['wall_ms']).toBe(5000);
  });

  it('includes impact_score combining self-cost and path weight', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000 } });

    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.entries[0].impact_score).toBeGreaterThan(0);
  });

  it('includes recommendation for the top bottleneck', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });

    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.entries[0].recommendation).toBeDefined();
    expect(result.entries[0].recommendation.length).toBeGreaterThan(0);
  });

  it('respects top_n', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'a' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'b' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 200 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'c' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 300 } });

    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms', top_n: 2 });
    expect(result.entries).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/bottleneck.ts
import type { Profile } from '../model/types.js';
import {
  getAllSpans,
  getSpanAncestry,
  computeSelfCost,
  valuesToRecord,
  extractKind,
} from './query.js';

export interface BottleneckInput {
  dimension: string;
  top_n?: number;
}

export interface BottleneckEntry {
  span_id: string;
  name: string;
  kind: string;
  ancestry: string[];
  self_cost: Record<string, number>;
  total_cost: Record<string, number>;
  /** Impact score: self_cost × (self_cost / total_profile_cost). Higher = bigger optimization opportunity. */
  impact_score: number;
  pct_of_total: number;
  recommendation: string;
}

export interface BottleneckResult {
  dimension: string;
  entries: BottleneckEntry[];
}

export function findBottlenecks(profile: Profile, input: BottleneckInput): BottleneckResult {
  const topN = input.top_n ?? 10;
  const dim = input.dimension;
  const dimIndex = profile.value_types.findIndex((vt) => vt.key === dim);
  if (dimIndex < 0) return { dimension: dim, entries: [] };

  const allSpans = getAllSpans(profile);

  // Compute total profile cost on this dimension
  let totalCost = 0;
  for (const span of allSpans) {
    const sc = computeSelfCost(profile, span);
    totalCost += sc[dimIndex] ?? 0;
  }
  if (totalCost === 0) return { dimension: dim, entries: [] };

  const entries: BottleneckEntry[] = [];

  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span);
    const selfVal = selfCost[dimIndex] ?? 0;
    if (selfVal <= 0) continue;

    const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
    const pctOfTotal = (selfVal / totalCost) * 100;

    // Impact score: self-cost weighted by its share of total
    // A span with 50% of total cost and 5000ms self-time scores higher than
    // a span with 5% of total cost and 5000ms self-time
    const impactScore = selfVal * (selfVal / totalCost);

    entries.push({
      span_id: span.id,
      name: frameName,
      kind: extractKind(frameName),
      ancestry: getSpanAncestry(profile, span),
      self_cost: valuesToRecord(profile, selfCost),
      total_cost: valuesToRecord(profile, span.values),
      impact_score: Math.round(impactScore * 100) / 100,
      pct_of_total: Math.round(pctOfTotal * 100) / 100,
      recommendation: generateRecommendation(frameName, pctOfTotal),
    });
  }

  entries.sort((a, b) => b.impact_score - a.impact_score);

  return {
    dimension: dim,
    entries: entries.slice(0, topN),
  };
}

function generateRecommendation(frameName: string, pctOfTotal: number): string {
  const kind = extractKind(frameName);
  const pctStr = `${Math.round(pctOfTotal)}%`;

  switch (kind) {
    case 'bash':
      return `This command accounts for ${pctStr} of total cost. Consider scoping it more tightly or caching results.`;
    case 'file_read':
      return `This file read accounts for ${pctStr} of total cost. Consider reading only the relevant section or caching content.`;
    case 'file_write':
      return `This file write accounts for ${pctStr} of total cost. Consider batching changes into fewer writes.`;
    case 'thinking':
      return `Thinking accounts for ${pctStr} of total cost. Consider breaking the problem into smaller steps.`;
    case 'validation':
      return `Validation accounts for ${pctStr} of total cost. Consider scoping tests to affected files.`;
    default:
      return `This operation accounts for ${pctStr} of total cost. Consider whether it can be optimized or eliminated.`;
  }
}
```

- [ ] **Step 4: Run tests, lint, commit**

```bash
npx vitest run src/analysis/bottleneck.test.ts
npx eslint src/analysis/bottleneck.ts src/analysis/bottleneck.test.ts
git add src/analysis/bottleneck.ts src/analysis/bottleneck.test.ts
git commit -m "feat: add bottleneck analysis tool"
```

---

### Task 3: spinpaths Tool

Detect paths with high wall time but low useful work output — busy-waiting, spinning, or inefficient processing. Compares wall_ms against output metrics (output_tokens, bytes_written) to find spans where time was spent without producing results.

**Files:**
- Create: `src/analysis/spinpaths.ts`
- Test: `src/analysis/spinpaths.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/spinpaths.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findSpinpaths } from './spinpaths.js';

describe('findSpinpaths', () => {
  it('flags high wall time with no output', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 30000 } }); // 30s, no output
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 200, output_tokens: 500 } }); // Productive

    const result = findSpinpaths(state.builder.profile, {});
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].name).toBe('bash:npm test');
  });

  it('does not flag spans with proportional output', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500, output_tokens: 800 } });

    const result = findSpinpaths(state.builder.profile, {});
    expect(result.entries).toHaveLength(0);
  });

  it('includes wall_ms and output metrics', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'sleep 60' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 60000 } });

    const result = findSpinpaths(state.builder.profile, {});
    if (result.entries.length > 0) {
      expect(result.entries[0].wall_ms).toBe(60000);
      expect(result.entries[0].output_produced).toBeDefined();
    }
  });

  it('respects min_wall_ms threshold', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'fast' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } }); // Under threshold

    const result = findSpinpaths(state.builder.profile, { min_wall_ms: 1000 });
    expect(result.entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/spinpaths.ts
import type { Profile } from '../model/types.js';
import {
  getAllSpans,
  getSpanAncestry,
  computeSelfCost,
  extractKind,
} from './query.js';

export interface SpinpathsInput {
  /** Minimum wall_ms to consider. Default: 5000 (5 seconds). */
  min_wall_ms?: number;
}

export interface SpinpathEntry {
  span_id: string;
  name: string;
  ancestry: string[];
  wall_ms: number;
  /** Summary of output metrics (tokens, bytes) produced during this span. */
  output_produced: Record<string, number>;
  /** Ratio of output to wall time. Lower = more spinning. */
  efficiency_ratio: number;
  recommendation: string;
}

export interface SpinpathsResult {
  entries: SpinpathEntry[];
}

export function findSpinpaths(profile: Profile, input: SpinpathsInput): SpinpathsResult {
  const minWallMs = input.min_wall_ms ?? 5000;
  const allSpans = getAllSpans(profile);

  // Find output dimension indices
  const wallIdx = profile.value_types.findIndex((vt) => vt.key === 'wall_ms');
  const outputIndices = profile.value_types
    .map((vt, i) => ({ key: vt.key, idx: i }))
    .filter(({ key }) =>
      key === 'output_tokens' || key === 'bytes_written' || key === 'bytes_read',
    );

  const entries: SpinpathEntry[] = [];

  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span);
    const wallMs = wallIdx >= 0 ? (selfCost[wallIdx] ?? 0) : 0;
    if (wallMs < minWallMs) continue;

    // Sum output metrics
    const outputProduced: Record<string, number> = {};
    let totalOutput = 0;
    for (const { key, idx } of outputIndices) {
      const val = selfCost[idx] ?? 0;
      outputProduced[key] = val;
      totalOutput += val;
    }

    // Efficiency: output per second of wall time
    const wallSeconds = wallMs / 1000;
    const efficiencyRatio = wallSeconds > 0 ? totalOutput / wallSeconds : 0;

    // Flag as spinning if high wall time with very low output
    // Threshold: less than 10 units of output per second
    if (efficiencyRatio < 10) {
      const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
      entries.push({
        span_id: span.id,
        name: frameName,
        ancestry: getSpanAncestry(profile, span),
        wall_ms: wallMs,
        output_produced: outputProduced,
        efficiency_ratio: Math.round(efficiencyRatio * 100) / 100,
        recommendation: generateSpinRecommendation(frameName, wallMs, totalOutput),
      });
    }
  }

  // Sort by wall_ms descending (biggest time sinks first)
  entries.sort((a, b) => b.wall_ms - a.wall_ms);

  return { entries };
}

function generateSpinRecommendation(name: string, wallMs: number, totalOutput: number): string {
  const kind = extractKind(name);
  const seconds = Math.round(wallMs / 1000);

  if (totalOutput === 0) {
    return `${name} spent ${seconds}s with no measurable output. Consider whether this operation is necessary or can be replaced.`;
  }
  return `${name} spent ${seconds}s producing minimal output. Consider breaking into smaller steps or adding timeouts.`;
}
```

- [ ] **Step 4: Run tests, lint, commit**

```bash
npx vitest run src/analysis/spinpaths.test.ts
npx eslint src/analysis/spinpaths.ts src/analysis/spinpaths.test.ts
git add src/analysis/spinpaths.ts src/analysis/spinpaths.test.ts
git commit -m "feat: add spinpaths analysis tool"
```

---

### Task 4: starvations Tool

Detect lanes/threads that are idle while other lanes are busy. Relevant for multi-threaded imported profiles (Gecko, pprof) where thread starvation indicates lock contention, unbalanced work distribution, or serialization bottlenecks.

**Files:**
- Create: `src/analysis/starvations.ts`
- Test: `src/analysis/starvations.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/starvations.test.ts
import { describe, it, expect } from 'vitest';
import { importChromeTrace } from '../importers/chrome-trace.js';
import { findStarvations } from './starvations.js';

describe('findStarvations', () => {
  it('detects idle lane while another is busy', () => {
    // Thread 1 busy from 0-10s, Thread 2 only busy 0-2s then idle
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'Worker 1' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'Worker 2' } },
      { ph: 'X', name: 'heavy_work', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'small_task', ts: 0, dur: 2000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});

    expect(result.entries.length).toBeGreaterThan(0);
    // Worker 2 should be flagged as starved
    const starved = result.entries.find((e) => e.lane_name === 'Worker 2');
    expect(starved).toBeDefined();
    if (starved) {
      expect(starved.idle_ms).toBeGreaterThan(0);
    }
  });

  it('returns empty for single-lane profiles', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 5000000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    expect(result.entries).toHaveLength(0);
  });

  it('does not flag lanes that are busy throughout', () => {
    const events = [
      { ph: 'X', name: 'work_a', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'work_b', ts: 0, dur: 10000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    expect(result.entries).toHaveLength(0);
  });

  it('includes idle percentage and recommendation', () => {
    const events = [
      { ph: 'X', name: 'long_work', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'tiny', ts: 0, dur: 1000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    if (result.entries.length > 0) {
      expect(result.entries[0].idle_pct).toBeGreaterThan(0);
      expect(result.entries[0].recommendation.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/starvations.ts
import type { Profile, Lane } from '../model/types.js';

export interface StarvationsInput {
  /** Minimum idle percentage to flag. Default: 50. */
  min_idle_pct?: number;
}

export interface StarvationEntry {
  lane_id: string;
  lane_name: string;
  /** Total time the lane was idle while at least one other lane was active. */
  idle_ms: number;
  /** Total time any lane was active (the profile's active window). */
  active_window_ms: number;
  /** Percentage of active window that this lane was idle. */
  idle_pct: number;
  /** Time ranges where this lane was idle. */
  idle_ranges: Array<{ start_ms: number; end_ms: number; duration_ms: number }>;
  recommendation: string;
}

export interface StarvationsResult {
  entries: StarvationEntry[];
}

export function findStarvations(profile: Profile, input: StarvationsInput): StarvationsResult {
  const minIdlePct = input.min_idle_pct ?? 50;

  // Need at least 2 lanes to detect starvation
  const activeLanes = profile.lanes.filter((l) => l.spans.length > 0 || l.samples.length > 0);
  if (activeLanes.length < 2) return { entries: [] };

  // Find the global active window (earliest start to latest end across all lanes)
  let globalStart = Infinity;
  let globalEnd = 0;
  for (const lane of activeLanes) {
    for (const span of lane.spans) {
      if (span.start_time < globalStart) globalStart = span.start_time;
      if (span.end_time > globalEnd) globalEnd = span.end_time;
    }
  }
  if (globalStart >= globalEnd) return { entries: [] };

  const activeWindowMs = globalEnd - globalStart;
  const entries: StarvationEntry[] = [];

  for (const lane of activeLanes) {
    // Compute busy intervals for this lane
    const busyIntervals = lane.spans
      .map((s) => ({ start: s.start_time, end: s.end_time }))
      .sort((a, b) => a.start - b.start);

    // Merge overlapping intervals
    const merged = mergeIntervals(busyIntervals);

    // Compute idle time within the global active window
    const idleRanges: Array<{ start_ms: number; end_ms: number; duration_ms: number }> = [];
    let cursor = globalStart;

    for (const interval of merged) {
      if (interval.start > cursor) {
        const gap = interval.start - cursor;
        idleRanges.push({
          start_ms: cursor,
          end_ms: interval.start,
          duration_ms: gap,
        });
      }
      cursor = Math.max(cursor, interval.end);
    }
    // Trailing idle
    if (cursor < globalEnd) {
      idleRanges.push({
        start_ms: cursor,
        end_ms: globalEnd,
        duration_ms: globalEnd - cursor,
      });
    }

    const idleMs = idleRanges.reduce((sum, r) => sum + r.duration_ms, 0);
    const idlePct = activeWindowMs > 0 ? (idleMs / activeWindowMs) * 100 : 0;

    if (idlePct >= minIdlePct) {
      entries.push({
        lane_id: lane.id,
        lane_name: lane.name,
        idle_ms: Math.round(idleMs),
        active_window_ms: Math.round(activeWindowMs),
        idle_pct: Math.round(idlePct * 100) / 100,
        idle_ranges: idleRanges.map((r) => ({
          start_ms: Math.round(r.start_ms),
          end_ms: Math.round(r.end_ms),
          duration_ms: Math.round(r.duration_ms),
        })),
        recommendation: `Lane '${lane.name}' was idle ${Math.round(idlePct)}% of the time while other lanes were active. This may indicate lock contention, unbalanced work distribution, or serialization.`,
      });
    }
  }

  entries.sort((a, b) => b.idle_pct - a.idle_pct);
  return { entries };
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (intervals.length === 0) return [];
  const result: Array<{ start: number; end: number }> = [{ ...intervals[0] }];
  for (let i = 1; i < intervals.length; i++) {
    const last = result[result.length - 1];
    if (intervals[i].start <= last.end) {
      last.end = Math.max(last.end, intervals[i].end);
    } else {
      result.push({ ...intervals[i] });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests, lint, commit**

```bash
npx vitest run src/analysis/starvations.test.ts
npx eslint src/analysis/starvations.ts src/analysis/starvations.test.ts
git add src/analysis/starvations.ts src/analysis/starvations.test.ts
git commit -m "feat: add starvations analysis tool"
```

---

### Task 5: Wire All 4 Tools into MCP Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add integration tests**

Append inside existing `describe('MCP Server', ...)`:

```typescript
it('hotpaths returns ranked paths', async () => {
  const c = await createTestClient();
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
  const result = await c.callTool({ name: 'hotpaths', arguments: { dimension: 'wall_ms' } });
  const parsed = parseToolResult(result) as { paths: unknown[] };
  expect(parsed.paths.length).toBeGreaterThan(0);
});

it('bottleneck returns optimization targets', async () => {
  const c = await createTestClient();
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
  const result = await c.callTool({ name: 'bottleneck', arguments: { dimension: 'wall_ms' } });
  const parsed = parseToolResult(result) as { entries: unknown[] };
  expect(parsed.entries.length).toBeGreaterThan(0);
});

it('spinpaths detects low-output spans', async () => {
  const c = await createTestClient();
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'sleep' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 30000 } } });
  const result = await c.callTool({ name: 'spinpaths', arguments: {} });
  const parsed = parseToolResult(result) as { entries: unknown[] };
  expect(parsed.entries.length).toBeGreaterThan(0);
});

it('starvations returns empty for single-lane', async () => {
  const c = await createTestClient();
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } } });
  const result = await c.callTool({ name: 'starvations', arguments: {} });
  const parsed = parseToolResult(result) as { entries: unknown[] };
  expect(parsed.entries).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Register tools in server.ts**

Add imports:
```typescript
import { findHotpaths } from './analysis/hotpaths.js';
import { findBottlenecks } from './analysis/bottleneck.js';
import { findSpinpaths } from './analysis/spinpaths.js';
import { findStarvations } from './analysis/starvations.js';
```

Register tools (after export_profile):

```typescript
server.registerTool(
  'hotpaths',
  {
    description:
      "Find the critical call paths that account for the most cost. Unlike hotspots (flat ranking), this shows complete root-to-leaf paths. Use to understand which call chains dominate execution.",
    inputSchema: {
      dimension: z.string(),
      top_n: z.number().optional(),
    },
  },
  (args) => {
    const result = findHotpaths(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'bottleneck',
  {
    description:
      "Find the single operations where optimization would have the most impact. Combines self-cost with path criticality — 'if you could speed up one thing, what would move the needle?'",
    inputSchema: {
      dimension: z.string(),
      top_n: z.number().optional(),
    },
  },
  (args) => {
    const result = findBottlenecks(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'spinpaths',
  {
    description:
      "Detect operations with high wall time but low useful output — busy-waiting, spinning, or inefficient processing. Flags spans that spent significant time without producing tokens, bytes, or other measurable work.",
    inputSchema: {
      min_wall_ms: z.number().optional(),
    },
  },
  (args) => {
    const result = findSpinpaths(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'starvations',
  {
    description:
      "Detect threads/lanes that are idle while others are active — indicates lock contention, unbalanced work, or serialization. Most useful with multi-threaded imported profiles (Gecko, Chrome trace).",
    inputSchema: {
      min_idle_pct: z.number().optional(),
    },
  },
  (args) => {
    const result = findStarvations(state.builder.profile, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 4: Run full test suite and lint**

```bash
npx vitest run
npx eslint src/
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: wire hotpaths, bottleneck, spinpaths, starvations into MCP server"
```

---

## Summary

After completing all 5 tasks, tracemeld will have **12 MCP tools**:

| Tool | Stage | What it does |
|------|-------|-------------|
| `trace` | Instrument | begin/end spans |
| `mark` | Instrument | instant markers |
| `profile_summary` | Notice | headline numbers |
| `hotspots` | Locate | flat ranking by self-cost |
| `hotpaths` | Locate | **critical root-to-leaf paths** |
| `bottleneck` | Locate | **highest optimization impact** |
| `explain_span` | Diagnose | deep-dive into one span |
| `spinpaths` | Diagnose | **high time, low output detection** |
| `starvations` | Diagnose | **multi-lane idle detection** |
| `find_waste` | Prescribe | anti-pattern waste items |
| `import_profile` | Import | load external profiles |
| `export_profile` | Export | export to collapsed stacks |
