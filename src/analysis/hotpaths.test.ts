// src/analysis/hotpaths.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findHotpaths } from './hotpaths.js';
import { importCollapsed } from '../importers/collapsed.js';

describe('findHotpaths', () => {
  it('returns the heaviest root-to-leaf path', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'end', kind: 'session' });

    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.paths.length).toBeGreaterThan(0);
    const topPath = result.paths[0];
    expect(topPath.frames[topPath.frames.length - 1]).toBe('bash:npm test');
    expect(topPath.leaf_cost).toBe(5000);
  });

  it('returns multiple paths ranked by cost', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'a' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'b' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'c' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 300 } });

    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms', top_n: 3 });
    expect(result.paths).toHaveLength(3);
    expect(result.paths[0].leaf_cost).toBeGreaterThanOrEqual(result.paths[1].leaf_cost);
    expect(result.paths[1].leaf_cost).toBeGreaterThanOrEqual(result.paths[2].leaf_cost);
  });

  it('includes percentage of total', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });

    const result = findHotpaths(state.builder.profile, { dimension: 'wall_ms', top_n: 1 });
    expect(result.paths[0].pct_of_total).toBeGreaterThan(0);
    expect(result.paths[0].pct_of_total).toBeLessThanOrEqual(100);
  });

  it('works with sample-based profiles', () => {
    const imported = importCollapsed('a;b;c 50\na;b;d 30\na;e 20\n', 'test.txt');
    const result = findHotpaths(imported.profile, { dimension: 'weight' });
    expect(result.paths[0].frames).toEqual(['a', 'b', 'c']);
    expect(result.paths[0].leaf_cost).toBe(50);
  });

  it('returns empty for unknown dimension', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    const result = findHotpaths(state.builder.profile, { dimension: 'nonexistent' });
    expect(result.paths).toHaveLength(0);
  });
});
