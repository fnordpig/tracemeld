// src/analysis/bottleneck.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findBottlenecks } from './bottleneck.js';

describe('findBottlenecks', () => {
  it('identifies the span with highest optimization impact', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'end', kind: 'session' });

    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].name).toBe('bash:npm test');
    expect(result.entries[0].self_cost['wall_ms']).toBe(5000);
  });

  it('includes impact_score', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000 } });
    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
    expect(result.entries[0].impact_score).toBeGreaterThan(0);
  });

  it('includes recommendation', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    const result = findBottlenecks(state.builder.profile, { dimension: 'wall_ms' });
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

  it('returns empty for unknown dimension', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });
    const result = findBottlenecks(state.builder.profile, { dimension: 'nonexistent' });
    expect(result.entries).toHaveLength(0);
  });
});
