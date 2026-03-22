import { describe, it, expect } from 'vitest';
import { diffBaselines } from './diff.js';
import type { BaselineDigest } from '../exporters/baseline-types.js';

function makeDigest(overrides: Partial<BaselineDigest> = {}): BaselineDigest {
  return {
    version: 1,
    exporter: 'tracemeld@test',
    created_at: Date.now(),
    tags: { checkpoint: 'baseline' },
    value_types: [{ key: 'wall_ms', description: 'Wall time', unit: 'milliseconds' }],
    source_formats: [],
    totals: { wall_ms: 1000 },
    kind_breakdown: [],
    frame_costs: [],
    hotspots: [],
    patterns: [],
    stats: { span_count: 0, sample_count: 0, frame_count: 0, lane_count: 1, error_count: 0, wall_duration_ms: 1000 },
    ...overrides,
  };
}

describe('diffBaselines', () => {
  it('returns empty diff for identical digests', () => {
    const digest = makeDigest({
      frame_costs: [
        { stack: 'root;a', self_cost: [500], total_cost: [500], call_count: 1 },
        { stack: 'root;b', self_cost: [500], total_cost: [500], call_count: 1 },
      ],
    });
    const result = diffBaselines(digest, digest);
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
    expect(result.new_stacks).toHaveLength(0);
    expect(result.removed_stacks).toHaveLength(0);
  });

  it('detects regressions when costs increase', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;a', self_cost: [300], total_cost: [300], call_count: 1 },
        { stack: 'root;b', self_cost: [700], total_cost: [700], call_count: 1 },
      ],
    });
    const after = makeDigest({
      totals: { wall_ms: 1500 },
      frame_costs: [
        { stack: 'root;a', self_cost: [300], total_cost: [300], call_count: 1 },
        { stack: 'root;b', self_cost: [1200], total_cost: [1200], call_count: 1 },
      ],
    });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.regressions.length).toBeGreaterThan(0);
    expect(result.regressions[0].name).toBe('b');
    expect(result.regressions[0].delta.wall_ms).toBe(500);
  });

  it('detects improvements when costs decrease', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;slow', self_cost: [800], total_cost: [800], call_count: 1 },
      ],
    });
    const after = makeDigest({
      totals: { wall_ms: 400 },
      frame_costs: [
        { stack: 'root;slow', self_cost: [200], total_cost: [200], call_count: 1 },
      ],
    });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.improvements.length).toBeGreaterThan(0);
    expect(result.improvements[0].delta.wall_ms).toBe(-600);
  });

  it('detects new stacks', () => {
    const before = makeDigest({
      frame_costs: [{ stack: 'root;a', self_cost: [1000], total_cost: [1000], call_count: 1 }],
    });
    const after = makeDigest({
      frame_costs: [
        { stack: 'root;a', self_cost: [800], total_cost: [800], call_count: 1 },
        { stack: 'root;new_func', self_cost: [200], total_cost: [200], call_count: 1 },
      ],
    });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.new_stacks.length).toBe(1);
    expect(result.new_stacks[0].name).toBe('new_func');
  });

  it('detects removed stacks', () => {
    const before = makeDigest({
      frame_costs: [
        { stack: 'root;a', self_cost: [500], total_cost: [500], call_count: 1 },
        { stack: 'root;removed', self_cost: [500], total_cost: [500], call_count: 1 },
      ],
    });
    const after = makeDigest({
      frame_costs: [{ stack: 'root;a', self_cost: [1000], total_cost: [1000], call_count: 1 }],
    });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.removed_stacks.length).toBe(1);
    expect(result.removed_stacks[0].name).toBe('removed');
  });

  it('normalizes by default when totals differ', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [{ stack: 'root;a', self_cost: [1000], total_cost: [1000], call_count: 1 }],
    });
    const after = makeDigest({
      totals: { wall_ms: 2000 },
      frame_costs: [{ stack: 'root;a', self_cost: [2000], total_cost: [2000], call_count: 1 }],
    });
    // With normalization: norm_factor = 2000/1000 = 2
    // Scaled before cost = 1000 * 2 = 2000, after = 2000, delta = 0
    const result = diffBaselines(before, after);
    expect(result.normalized).toBe(true);
    expect(result.norm_factor).toBeCloseTo(2);
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });

  it('filters by min_delta_pct', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;small', self_cost: [500], total_cost: [500], call_count: 1 },
        { stack: 'root;big', self_cost: [500], total_cost: [500], call_count: 1 },
      ],
    });
    const after = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;small', self_cost: [510], total_cost: [510], call_count: 1 },  // ~2% increase
        { stack: 'root;big', self_cost: [800], total_cost: [800], call_count: 1 },    // 60% increase
      ],
    });
    const result = diffBaselines(before, after, { normalize: false, min_delta_pct: 10 });
    // small's delta_pct = (510-500)/510*100 ≈ 2% — filtered out
    // big's delta_pct = (800-500)/800*100 = 37.5% — included
    expect(result.regressions.length).toBe(1);
    expect(result.regressions[0].name).toBe('big');
  });

  it('uses flamegraph.pl percentage convention: (new-old)/new', () => {
    const before = makeDigest({
      totals: { wall_ms: 100 },
      frame_costs: [{ stack: 'a', self_cost: [6], total_cost: [6], call_count: 1 }],
    });
    const after = makeDigest({
      totals: { wall_ms: 100 },
      frame_costs: [{ stack: 'a', self_cost: [7], total_cost: [7], call_count: 1 }],
    });
    const result = diffBaselines(before, after, { normalize: false, min_delta_pct: 0 });
    // (7-6)/7*100 = 14.28...%
    const pct = result.regressions[0].delta_pct.wall_ms;
    expect(pct).toBeCloseTo(14.29, 1);
  });

  it('flags cost shift as likely_refactoring', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;parent', self_cost: [100], total_cost: [800], call_count: 1 },
        { stack: 'root;parent;child_a', self_cost: [400], total_cost: [400], call_count: 1 },
        { stack: 'root;parent;child_b', self_cost: [300], total_cost: [300], call_count: 1 },
      ],
    });
    // Cost shifted from child_a to child_b, but parent total unchanged
    const after = makeDigest({
      totals: { wall_ms: 1000 },
      frame_costs: [
        { stack: 'root;parent', self_cost: [100], total_cost: [800], call_count: 1 },
        { stack: 'root;parent;child_a', self_cost: [200], total_cost: [200], call_count: 1 },
        { stack: 'root;parent;child_b', self_cost: [500], total_cost: [500], call_count: 1 },
      ],
    });
    const result = diffBaselines(before, after, { normalize: false, min_delta_pct: 0 });
    const childB = result.regressions.find((e) => e.name === 'child_b');
    expect(childB).toBeDefined();
    expect(childB!.likely_refactoring).toBe(true);
  });

  it('computes headline deltas per dimension', () => {
    const before = makeDigest({
      totals: { wall_ms: 1000 },
    });
    const after = makeDigest({
      totals: { wall_ms: 800 },
    });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.headline.wall_ms.delta).toBe(-200);
    expect(result.headline.wall_ms.before).toBe(1000);
    expect(result.headline.wall_ms.after).toBe(800);
  });

  it('reports regression warnings for increased dimensions', () => {
    const before = makeDigest({ totals: { wall_ms: 1000 } });
    const after = makeDigest({ totals: { wall_ms: 1500 } });
    const result = diffBaselines(before, after, { normalize: false });
    expect(result.regression_warnings.length).toBe(1);
    expect(result.regression_warnings[0].dimension).toBe('wall_ms');
  });

  it('computes pattern diff', () => {
    const before = makeDigest({
      patterns: [
        { name: 'retry_storm', severity: 'warning', description: 'excessive retries', count: 3 },
        { name: 'blind_edit', severity: 'info', description: 'edits without reading', count: 1 },
      ],
    });
    const after = makeDigest({
      patterns: [
        { name: 'retry_storm', severity: 'warning', description: 'excessive retries', count: 1 },
        { name: 'token_waste', severity: 'warning', description: 'wasted tokens', count: 2 },
      ],
    });
    const result = diffBaselines(before, after);
    expect(result.pattern_diff.new_patterns).toContain('token_waste');
    expect(result.pattern_diff.resolved_patterns).toContain('blind_edit');
  });

  it('handles multi-dimensional profiles', () => {
    const before = makeDigest({
      value_types: [
        { key: 'wall_ms', description: 'Wall time', unit: 'milliseconds' },
        { key: 'tokens', description: 'Tokens', unit: 'none' },
      ],
      totals: { wall_ms: 1000, tokens: 5000 },
      frame_costs: [
        { stack: 'root;a', self_cost: [500, 3000], total_cost: [500, 3000], call_count: 1 },
      ],
    });
    const after = makeDigest({
      value_types: [
        { key: 'wall_ms', description: 'Wall time', unit: 'milliseconds' },
        { key: 'tokens', description: 'Tokens', unit: 'none' },
      ],
      totals: { wall_ms: 800, tokens: 6000 },
      frame_costs: [
        { stack: 'root;a', self_cost: [400, 4000], total_cost: [400, 4000], call_count: 1 },
      ],
    });
    const result = diffBaselines(before, after, { normalize: false, min_delta_pct: 0 });
    // wall_ms improved, tokens regressed
    expect(result.headline.wall_ms.delta).toBe(-200);
    expect(result.headline.tokens.delta).toBe(1000);
    expect(result.regression_warnings.some((w) => w.dimension === 'tokens')).toBe(true);
  });

  it('respects top_n limit', () => {
    const costs = Array.from({ length: 30 }, (_, i) => ({
      stack: `root;func_${i}`,
      self_cost: [100 + i * 10],
      total_cost: [100 + i * 10],
      call_count: 1,
    }));
    const before = makeDigest({
      totals: { wall_ms: 10000 },
      frame_costs: costs,
    });
    const afterCosts = costs.map((c) => ({
      ...c,
      self_cost: [c.self_cost[0] + 50],
      total_cost: [c.total_cost[0] + 50],
    }));
    const after = makeDigest({
      totals: { wall_ms: 11500 },
      frame_costs: afterCosts,
    });
    const result = diffBaselines(before, after, { normalize: false, min_delta_pct: 0, top_n: 5 });
    expect(result.regressions.length).toBeLessThanOrEqual(5);
  });
});
