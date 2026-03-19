# Anti-Pattern Detection & find_waste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an anti-pattern detection engine with 3 practical detectors (`retry_loop`, `redundant_read`, `blind_edit`) and the `find_waste` analysis tool, then integrate patterns into the existing `hotspots` and `explain_span` tools.

**Architecture:** Each pattern detector is a pure function `(profile: Profile) => PatternMatch[]` returning matches with span IDs, savings estimates, and recommendations. A `PatternRegistry` runs all registered detectors and caches results (invalidated by `ProfilerState.invalidatePatternCache()`). The `find_waste` tool aggregates all matches into `WasteItem[]`. The existing `hotspots` and `explain_span` tools are updated to query the registry for relevant patterns.

**Tech Stack:** TypeScript 5, MCP SDK, Zod 4, Vitest.

**Scope note:** Plan 3 of ~4. Implements the 3 most testable/valuable detectors. Remaining patterns (`context_inflation`, `unused_output`, `full_suite_single_change`, `scattered_edits`, `reverted_work`, `late_discovery`, `serial_independent`) can be added incrementally — the registry makes this trivial.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/patterns/types.ts` | `PatternMatch` interface, `PatternDetector` function type |
| `src/patterns/registry.ts` | `PatternRegistry` class — registers detectors, runs all, caches results |
| `src/patterns/retry-loop.ts` | Detects consecutive sibling spans with same frame and intervening errors |
| `src/patterns/redundant-read.ts` | Detects same file_read frame 2+ times in a turn with no intervening write |
| `src/patterns/blind-edit.ts` | Detects file_write with no preceding file_read for that file |
| `src/analysis/waste.ts` | `findWaste()` — aggregates pattern matches into WasteItems with savings |
| `src/model/state.ts` | Modified — add `PatternRegistry` instance |
| `src/analysis/hotspots.ts` | Modified — populate `patterns` field from registry |
| `src/analysis/explain.ts` | Modified — populate `patterns` and `recommendations` from registry |
| `src/server.ts` | Modified — register `find_waste` tool |

Test files: `src/patterns/registry.test.ts`, `src/patterns/retry-loop.test.ts`, `src/patterns/redundant-read.test.ts`, `src/patterns/blind-edit.test.ts`, `src/analysis/waste.test.ts`.

---

### Task 1: Pattern Types and Registry

**Files:**
- Create: `src/patterns/types.ts`
- Create: `src/patterns/registry.ts`
- Test: `src/patterns/registry.test.ts`

- [ ] **Step 1: Write the types (no test needed)**

```typescript
// src/patterns/types.ts
import type { Profile, DetectedPattern } from '../model/types.js';

/** A match produced by a pattern detector. */
export interface PatternMatch {
  /** The detected pattern (name, description, severity, evidence). */
  pattern: DetectedPattern;

  /** Span IDs involved in this match. */
  span_ids: string[];

  /** Estimated savings if this waste were eliminated. Keyed by value_type.key. */
  counterfactual_savings: Record<string, number>;

  /** Concrete recommendation for the LLM. */
  recommendation: string;
}

/** A pattern detector function. Pure: profile in, matches out. */
export type PatternDetector = (profile: Profile) => PatternMatch[];
```

- [ ] **Step 2: Write the failing tests for registry**

```typescript
// src/patterns/registry.test.ts
import { describe, it, expect } from 'vitest';
import { PatternRegistry } from './registry.js';
import type { PatternDetector, PatternMatch } from './types.js';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';

const noopDetector: PatternDetector = () => [];

const alwaysMatchDetector: PatternDetector = (profile) => {
  const spans = profile.lanes.flatMap((l) => l.spans);
  if (spans.length === 0) return [];
  return [
    {
      pattern: {
        name: 'test_pattern',
        description: 'A test pattern',
        severity: 'info' as const,
        evidence: {},
      },
      span_ids: [spans[0].id],
      counterfactual_savings: { wall_ms: 100 },
      recommendation: 'Fix it',
    },
  ];
};

describe('PatternRegistry', () => {
  it('starts with no detectors', () => {
    const registry = new PatternRegistry();
    const state = new ProfilerState();
    const matches = registry.detect(state.builder.profile);
    expect(matches).toEqual([]);
  });

  it('runs registered detectors', () => {
    const registry = new PatternRegistry();
    registry.register(alwaysMatchDetector);
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    const matches = registry.detect(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('test_pattern');
  });

  it('runs multiple detectors', () => {
    const registry = new PatternRegistry();
    registry.register(alwaysMatchDetector);
    registry.register(alwaysMatchDetector);
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    const matches = registry.detect(state.builder.profile);
    expect(matches).toHaveLength(2);
  });

  it('getMatchesForSpan filters by span_id', () => {
    const registry = new PatternRegistry();
    registry.register(alwaysMatchDetector);
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    const allMatches = registry.detect(state.builder.profile);
    const spanId = allMatches[0].span_ids[0];
    const forSpan = registry.getMatchesForSpan(state.builder.profile, spanId);
    expect(forSpan).toHaveLength(1);
    const forOther = registry.getMatchesForSpan(state.builder.profile, 'nonexistent');
    expect(forOther).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/patterns/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the registry implementation**

```typescript
// src/patterns/registry.ts
import type { Profile } from '../model/types.js';
import type { PatternDetector, PatternMatch } from './types.js';

export class PatternRegistry {
  private detectors: PatternDetector[] = [];
  private cache: { profileId: string; matches: PatternMatch[] } | null = null;

  register(detector: PatternDetector): void {
    this.detectors.push(detector);
    this.cache = null;
  }

  detect(profile: Profile): PatternMatch[] {
    if (this.cache && this.cache.profileId === profile.id) {
      return this.cache.matches;
    }

    const matches: PatternMatch[] = [];
    for (const detector of this.detectors) {
      matches.push(...detector(profile));
    }

    this.cache = { profileId: profile.id, matches };
    return matches;
  }

  getMatchesForSpan(profile: Profile, spanId: string): PatternMatch[] {
    const all = this.detect(profile);
    return all.filter((m) => m.span_ids.includes(spanId));
  }

  invalidate(): void {
    this.cache = null;
  }
}
```

NOTE: The cache uses `profile.id` which is stable for the lifetime of a profile. `invalidate()` is called by `ProfilerState` when spans change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/patterns/registry.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Lint and commit**

Run: `npx eslint src/patterns/types.ts src/patterns/registry.ts src/patterns/registry.test.ts`

```bash
git add src/patterns/types.ts src/patterns/registry.ts src/patterns/registry.test.ts
git commit -m "feat: add pattern registry and detection types"
```

---

### Task 2: retry_loop Detector

**Files:**
- Create: `src/patterns/retry-loop.ts`
- Test: `src/patterns/retry-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/patterns/retry-loop.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectRetryLoop } from './retry-loop.js';

describe('detectRetryLoop', () => {
  it('detects consecutive sibling spans with same frame and error', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    // First attempt fails
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit code 1', cost: { wall_ms: 5000 } });
    // Second attempt (same frame)
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('retry_loop');
    expect(matches[0].span_ids).toHaveLength(2);
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(5000);
  });

  it('does not flag non-consecutive same-frame spans', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit code 1', cost: { wall_ms: 5000 } });
    // Different operation in between
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/foo.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 100 } });
    // Same bash but not consecutive sibling
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag consecutive same-frame without error', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('detects triple retry', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail 1', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail 2', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].span_ids).toHaveLength(3);
    // Savings = cost of all retries except the last
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(6000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/patterns/retry-loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/patterns/retry-loop.ts
import type { Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, getSpanById, valuesToRecord } from '../analysis/query.js';

export function detectRetryLoop(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Group spans by parent_id to find siblings
  const siblingGroups = new Map<string, Span[]>();
  for (const span of allSpans) {
    const parentKey = span.parent_id ?? '__root__';
    let group = siblingGroups.get(parentKey);
    if (!group) {
      group = [];
      siblingGroups.set(parentKey, group);
    }
    group.push(span);
  }

  for (const siblings of siblingGroups.values()) {
    // Sort siblings by start_time
    siblings.sort((a, b) => a.start_time - b.start_time);

    let i = 0;
    while (i < siblings.length) {
      const run: Span[] = [siblings[i]];

      // Collect consecutive siblings with same frame_index
      while (
        i + 1 < siblings.length &&
        siblings[i + 1].frame_index === run[0].frame_index
      ) {
        i++;
        run.push(siblings[i]);
      }

      // A retry loop requires 2+ consecutive same-frame spans
      // where at least one (except possibly the last) has an error
      if (run.length >= 2) {
        const hasError = run.slice(0, -1).some((s) => s.error);
        if (hasError) {
          // Savings = sum of all spans except the last (the "successful" one)
          const savings = new Array<number>(profile.value_types.length).fill(0);
          for (let j = 0; j < run.length - 1; j++) {
            for (let k = 0; k < savings.length; k++) {
              savings[k] += run[j].values[k] ?? 0;
            }
          }

          matches.push({
            pattern: {
              name: 'retry_loop',
              description: `${run.length} consecutive attempts of the same operation with intervening errors`,
              severity: run.length >= 3 ? 'warning' : 'info',
              evidence: {
                attempt_count: run.length,
                errors: run.filter((s) => s.error).map((s) => s.error),
              },
            },
            span_ids: run.map((s) => s.id),
            counterfactual_savings: valuesToRecord(profile, savings),
            recommendation:
              'Read the error carefully before retrying. Consider a different approach after the first failure.',
          });
        }
      }

      i++;
    }
  }

  return matches;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/patterns/retry-loop.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/patterns/retry-loop.ts src/patterns/retry-loop.test.ts
git commit -m "feat: add retry_loop pattern detector"
```

---

### Task 3: redundant_read Detector

**Files:**
- Create: `src/patterns/redundant-read.ts`
- Test: `src/patterns/redundant-read.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/patterns/redundant-read.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectRedundantRead } from './redundant-read.js';

describe('detectRedundantRead', () => {
  it('detects same file read twice in a turn with no write', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'thinking', name: 'analyzing' });
    handleTrace(state, { action: 'end', kind: 'thinking', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('redundant_read');
    expect(matches[0].counterfactual_savings['input_tokens']).toBe(3000);
  });

  it('does not flag reads separated by a write to the same file', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { output_tokens: 500 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag reads of different files', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/user.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 2000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/patterns/redundant-read.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/patterns/redundant-read.ts
import type { Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, getSpanById, extractKind, valuesToRecord } from '../analysis/query.js';

export function detectRedundantRead(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Find turn spans to scope the analysis
  const turnSpans = allSpans.filter((s) => {
    const name = profile.frames[s.frame_index]?.name ?? '';
    return extractKind(name) === 'turn';
  });

  // If no turns, treat all spans as one group
  const groups = turnSpans.length > 0
    ? turnSpans.map((t) => getDescendantsInOrder(profile, t, allSpans))
    : [allSpans.sort((a, b) => a.start_time - b.start_time)];

  for (const descendants of groups) {
    // Track file reads, reset on file writes
    const readsByFile = new Map<string, Span[]>();

    for (const span of descendants) {
      const frameName = profile.frames[span.frame_index]?.name ?? '';
      const kind = extractKind(frameName);
      const detail = frameName.includes(':') ? frameName.substring(frameName.indexOf(':') + 1) : '';

      if (kind === 'file_write' && detail) {
        // A write resets the read tracker for this file
        readsByFile.delete(detail);
      } else if (kind === 'file_read' && detail) {
        let reads = readsByFile.get(detail);
        if (!reads) {
          reads = [];
          readsByFile.set(detail, reads);
        }
        reads.push(span);
      }
    }

    // Flag files that were read 2+ times without intervening write
    for (const [file, reads] of readsByFile) {
      if (reads.length >= 2) {
        // Savings = cost of all reads beyond the first
        const savings = new Array<number>(profile.value_types.length).fill(0);
        for (let i = 1; i < reads.length; i++) {
          for (let k = 0; k < savings.length; k++) {
            savings[k] += reads[i].values[k] ?? 0;
          }
        }

        matches.push({
          pattern: {
            name: 'redundant_read',
            description: `File '${file}' was read ${reads.length} times in one turn with no intervening write`,
            severity: 'warning',
            evidence: { file, read_count: reads.length },
          },
          span_ids: reads.map((s) => s.id),
          counterfactual_savings: valuesToRecord(profile, savings),
          recommendation:
            'Read the file once, retain content in reasoning, plan edits before re-reading.',
        });
      }
    }
  }

  return matches;
}

/** Walk the full subtree of a span, returning all descendants sorted by start_time. */
function getDescendantsInOrder(profile: Profile, parent: Span, allSpans: Span[]): Span[] {
  const result: Span[] = [];
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = allSpans.find((s) => s.id === id);
    if (!span) continue;
    result.push(span);
    stack.push(...span.children);
  }
  return result.sort((a, b) => a.start_time - b.start_time);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/patterns/redundant-read.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/patterns/redundant-read.ts src/patterns/redundant-read.test.ts
git commit -m "feat: add redundant_read pattern detector"
```

---

### Task 4: blind_edit Detector

**Files:**
- Create: `src/patterns/blind-edit.ts`
- Test: `src/patterns/blind-edit.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/patterns/blind-edit.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectBlindEdit } from './blind-edit.js';

describe('detectBlindEdit', () => {
  it('detects file_write with no preceding file_read for same file', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('blind_edit');
  });

  it('does not flag when file was read first', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag when file was read in previous turn', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('flags write to file not read (even if other files were read)', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/user.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 2000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/patterns/blind-edit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/patterns/blind-edit.ts
import type { Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, extractKind } from '../analysis/query.js';

export function detectBlindEdit(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Find turn spans in order
  const turnSpans = allSpans
    .filter((s) => {
      const name = profile.frames[s.frame_index]?.name ?? '';
      return extractKind(name) === 'turn';
    })
    .sort((a, b) => a.start_time - b.start_time);

  // Build a set of files read per turn by walking full subtree
  const filesReadByTurn = new Map<string, Set<string>>();

  for (const turn of turnSpans) {
    const filesRead = new Set<string>();
    collectFileOpsDeep(profile, turn, allSpans, 'file_read', filesRead);
    filesReadByTurn.set(turn.id, filesRead);
  }

  // Check each turn's writes against current + previous turn's reads
  for (let i = 0; i < turnSpans.length; i++) {
    const turn = turnSpans[i];
    const currentReads = filesReadByTurn.get(turn.id) ?? new Set<string>();
    const prevReads = i > 0
      ? (filesReadByTurn.get(turnSpans[i - 1].id) ?? new Set<string>())
      : new Set<string>();
    const allReads = new Set([...currentReads, ...prevReads]);

    // Find file_write spans in this turn's subtree
    const writeSpans = getFileWriteSpansDeep(profile, turn, allSpans);

    for (const writeSpan of writeSpans) {
      const frameName = profile.frames[writeSpan.frame_index]?.name ?? '';
      const file = frameName.includes(':') ? frameName.substring(frameName.indexOf(':') + 1) : '';
      if (file && !allReads.has(file)) {
        matches.push({
          pattern: {
            name: 'blind_edit',
            description: `Edited '${file}' without reading it first`,
            severity: 'warning',
            evidence: { file },
          },
          span_ids: [writeSpan.id],
          counterfactual_savings: {}, // Hard to estimate savings for blind edits
          recommendation:
            'Always read the current state of a file before editing it.',
        });
      }
    }
  }

  // Handle case with no turn structure
  if (turnSpans.length === 0) {
    const filesRead = new Set<string>();
    const orderedSpans = allSpans.sort((a, b) => a.start_time - b.start_time);
    for (const span of orderedSpans) {
      const frameName = profile.frames[span.frame_index]?.name ?? '';
      const kind = extractKind(frameName);
      const detail = frameName.includes(':') ? frameName.substring(frameName.indexOf(':') + 1) : '';
      if (kind === 'file_read' && detail) {
        filesRead.add(detail);
      } else if (kind === 'file_write' && detail && !filesRead.has(detail)) {
        matches.push({
          pattern: {
            name: 'blind_edit',
            description: `Edited '${detail}' without reading it first`,
            severity: 'warning',
            evidence: { file: detail },
          },
          span_ids: [span.id],
          counterfactual_savings: {},
          recommendation: 'Always read the current state of a file before editing it.',
        });
      }
    }
  }

  return matches;
}

/** Walk the full subtree collecting file paths for a given kind prefix. */
function collectFileOpsDeep(
  profile: Profile,
  parent: Span,
  allSpans: Span[],
  kindPrefix: string,
  result: Set<string>,
): void {
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = allSpans.find((s) => s.id === id);
    if (!span) continue;
    const frameName = profile.frames[span.frame_index]?.name ?? '';
    const kind = extractKind(frameName);
    const detail = frameName.includes(':') ? frameName.substring(frameName.indexOf(':') + 1) : '';
    if (kind === kindPrefix && detail) {
      result.add(detail);
    }
    stack.push(...span.children);
  }
}

/** Walk the full subtree finding file_write spans. */
function getFileWriteSpansDeep(profile: Profile, parent: Span, allSpans: Span[]): Span[] {
  const writes: Span[] = [];
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = allSpans.find((s) => s.id === id);
    if (!span) continue;
    const frameName = profile.frames[span.frame_index]?.name ?? '';
    if (extractKind(frameName) === 'file_write') {
      writes.push(span);
    }
    stack.push(...span.children);
  }
  return writes;
}
```

NOTE: There's a bug in the no-turn fallback — `file` variable reference should be `detail`. The implementer should catch this during self-review. The correct line is:

```typescript
description: `Edited '${detail}' without reading it first`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/patterns/blind-edit.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add src/patterns/blind-edit.ts src/patterns/blind-edit.test.ts
git commit -m "feat: add blind_edit pattern detector"
```

---

### Task 5: find_waste Tool + Integrate Patterns

**Files:**
- Create: `src/analysis/waste.ts`
- Test: `src/analysis/waste.test.ts`
- Modify: `src/model/state.ts` — add `PatternRegistry` instance
- Modify: `src/analysis/hotspots.ts` — populate `patterns` from registry
- Modify: `src/analysis/explain.ts` — populate `patterns` and `recommendations` from registry

- [ ] **Step 1: Write the failing tests**

```typescript
// src/analysis/waste.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findWaste } from './waste.js';
import { PatternRegistry } from '../patterns/registry.js';
import { detectRetryLoop } from '../patterns/retry-loop.js';
import { detectRedundantRead } from '../patterns/redundant-read.js';
import { detectBlindEdit } from '../patterns/blind-edit.js';

function buildRegistry(): PatternRegistry {
  const registry = new PatternRegistry();
  registry.register(detectRetryLoop);
  registry.register(detectRedundantRead);
  registry.register(detectBlindEdit);
  return registry;
}

describe('findWaste', () => {
  it('returns empty when no waste detected', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items).toHaveLength(0);
    expect(result.total_savings['wall_ms']).toBe(0);
  });

  it('detects retry loop waste', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items.length).toBeGreaterThan(0);
    const retryItem = result.items.find((i) => i.pattern === 'retry_loop');
    expect(retryItem).toBeDefined();
    expect(result.total_savings['wall_ms']).toBeGreaterThan(0);
  });

  it('detects redundant read waste', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    const readItem = result.items.find((i) => i.pattern === 'redundant_read');
    expect(readItem).toBeDefined();
  });

  it('sorts items by largest savings', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    // Retry loop: 5000ms waste
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    // Redundant read: 200ms waste
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/a.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 1000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/a.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 1000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    // First item should have larger savings
    const firstSavings = Math.max(...Object.values(result.items[0].counterfactual_savings));
    const secondSavings = Math.max(...Object.values(result.items[1].counterfactual_savings));
    expect(firstSavings).toBeGreaterThanOrEqual(secondSavings);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/analysis/waste.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/analysis/waste.ts
import type { Profile } from '../model/types.js';
import type { PatternRegistry } from '../patterns/registry.js';
import type { TimeRange } from './query.js';
import { filterSpansByTimeRange, getAllSpans } from './query.js';

export interface FindWasteInput {
  time_range?: TimeRange;
}

export interface WasteItem {
  pattern: string;
  description: string;
  span_ids: string[];
  counterfactual_savings: Record<string, number>;
  recommendation: string;
  evidence: Record<string, unknown>;
}

export interface FindWasteResult {
  total_savings: Record<string, number>;
  items: WasteItem[];
}

export function findWaste(
  profile: Profile,
  registry: PatternRegistry,
  input: FindWasteInput,
): FindWasteResult {
  const allMatches = registry.detect(profile);

  // Filter matches to time range if specified
  let matches = allMatches;
  if (input.time_range) {
    const spansInRange = new Set(
      filterSpansByTimeRange(getAllSpans(profile), input.time_range).map((s) => s.id),
    );
    matches = allMatches.filter((m) =>
      m.span_ids.some((id) => spansInRange.has(id)),
    );
  }

  // Convert to WasteItems
  const items: WasteItem[] = matches.map((m) => ({
    pattern: m.pattern.name,
    description: m.pattern.description,
    span_ids: m.span_ids,
    counterfactual_savings: m.counterfactual_savings,
    recommendation: m.recommendation,
    evidence: m.pattern.evidence,
  }));

  // Sort by largest savings (max across any dimension)
  items.sort((a, b) => {
    const aMax = Math.max(0, ...Object.values(a.counterfactual_savings));
    const bMax = Math.max(0, ...Object.values(b.counterfactual_savings));
    return bMax - aMax;
  });

  // Compute total savings
  const totalSavings: Record<string, number> = {};
  for (const vt of profile.value_types) {
    totalSavings[vt.key] = 0;
  }
  for (const item of items) {
    for (const [key, val] of Object.entries(item.counterfactual_savings)) {
      totalSavings[key] = (totalSavings[key] ?? 0) + val;
    }
  }

  return { total_savings: totalSavings, items };
}
```

- [ ] **Step 4: Update state.ts to include PatternRegistry**

Add to `src/model/state.ts`:

Import at top:
```typescript
import { PatternRegistry } from '../patterns/registry.js';
import { detectRetryLoop } from '../patterns/retry-loop.js';
import { detectRedundantRead } from '../patterns/redundant-read.js';
import { detectBlindEdit } from '../patterns/blind-edit.js';
```

Add `registry` field and wire it up:
```typescript
readonly registry: PatternRegistry;
```

In the constructor, after `this.builder = new ProfileBuilder('session');`:
```typescript
this.registry = new PatternRegistry();
this.registry.register(detectRetryLoop);
this.registry.register(detectRedundantRead);
this.registry.register(detectBlindEdit);
```

Update `invalidatePatternCache` to also invalidate the registry:
```typescript
invalidatePatternCache(): void {
  this.patternCache = null;
  this.registry.invalidate();
}
```

- [ ] **Step 5: Update hotspots.ts to populate patterns**

In `src/analysis/hotspots.ts`, add a `registry` parameter to `findHotspots`:

Change the function signature to:
```typescript
export function findHotspots(
  profile: Profile,
  input: HotspotsInput,
  registry?: PatternRegistry,
): HotspotsResult {
```

Import `PatternRegistry`:
```typescript
import type { PatternRegistry } from '../patterns/registry.js';
```

Replace `patterns: [],` in the entry construction with:
```typescript
patterns: registry
  ? registry.getMatchesForSpan(profile, item.span.id).map((m) => ({ ...m.pattern, span_ids: m.span_ids }))
  : [],
```

- [ ] **Step 6: Update explain.ts to populate patterns and recommendations**

In `src/analysis/explain.ts`, add a `registry` parameter to `explainSpan`:

Change the function signature to:
```typescript
export function explainSpan(
  profile: Profile,
  input: ExplainSpanInput,
  registry?: PatternRegistry,
): ExplainSpanResult {
```

Import `PatternRegistry`:
```typescript
import type { PatternRegistry } from '../patterns/registry.js';
```

Replace `patterns: [],` and `recommendations: [],` with:
```typescript
patterns: registry
  ? registry.getMatchesForSpan(profile, span.id).map((m) => ({ ...m.pattern, span_ids: m.span_ids }))
  : [],
recommendations: registry
  ? [...new Set(registry.getMatchesForSpan(profile, span.id).map((m) => m.recommendation))]
  : [],
```

- [ ] **Step 7: Run tests to verify everything passes**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Lint and commit**

Run: `npx eslint src/`

```bash
git add src/analysis/waste.ts src/analysis/waste.test.ts src/model/state.ts src/analysis/hotspots.ts src/analysis/explain.ts
git commit -m "feat: add find_waste tool and integrate patterns into hotspots/explain_span"
```

---

### Task 6: Wire find_waste into MCP Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add test to existing server.test.ts**

Append inside the `describe('MCP Server', ...)` block:

```typescript
it('find_waste returns waste items', async () => {
  const c = await createTestClient();
  // Create a retry loop pattern
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'turn', name: '1' } });
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 }, error: 'fail' } });
  await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
  await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'turn' } });

  const result = await c.callTool({
    name: 'find_waste',
    arguments: {},
  });
  const parsed = parseToolResult(result) as { items: Array<{ pattern: string }>; total_savings: Record<string, number> };
  expect(parsed.items.length).toBeGreaterThan(0);
  expect(parsed.total_savings['wall_ms']).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — find_waste tool not registered.

- [ ] **Step 3: Register find_waste in server.ts**

Add import:
```typescript
import { findWaste } from './analysis/waste.js';
```

Update the `hotspots` and `explain_span` tool handlers to pass `state.registry`:

For hotspots:
```typescript
const result = findHotspots(state.builder.profile, args, state.registry);
```

For explain_span:
```typescript
const result = explainSpan(state.builder.profile, args, state.registry);
```

Add find_waste registration after explain_span:
```typescript
server.registerTool(
  'find_waste',
  {
    description:
      'Identify work that didn\'t contribute to the final result: retries, unused reads, blind edits. Each waste item includes counterfactual savings and a concrete recommendation.',
    inputSchema: {
      time_range: z
        .object({
          start_ms: z.number(),
          end_ms: z.number(),
        })
        .optional(),
    },
  },
  (args) => {
    const result = findWaste(state.builder.profile, state.registry, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/`

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: wire find_waste into MCP server and pass registry to analysis tools"
```

---

## Summary

After completing all 6 tasks, tracemeld will have:

- **Pattern registry** — extensible detector system with caching
- **3 pattern detectors** — `retry_loop`, `redundant_read`, `blind_edit`
- **find_waste tool** — aggregates detected patterns with savings estimates
- **Integrated patterns** — `hotspots` and `explain_span` now populate their `patterns` fields
- **6 MCP tools total** — trace, mark, profile_summary, hotspots, explain_span, find_waste

Adding new detectors is now trivial: write a function `(profile: Profile) => PatternMatch[]`, register it in `state.ts`.

**Next plan:** Importers (collapsed stacks, Chrome trace, Gecko profile) + exporters.
