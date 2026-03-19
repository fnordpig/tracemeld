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
    expect(result.entries[0].name).toBe('bash:npm test');
  });

  it('ranks by input_tokens when requested', () => {
    const state = buildTestProfile();
    const result = findHotspots(state.builder.profile, { dimension: 'input_tokens' });
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
    expect(entry.self_cost['wall_ms']).toBe(5000);
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
