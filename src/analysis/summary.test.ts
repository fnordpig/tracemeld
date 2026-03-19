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
    expect(result.totals['wall_ms']).toBeGreaterThan(0);
  });

  it('groups by kind', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'kind' });
    const bashGroup = result.groups.find((g) => g.key === 'bash');
    if (!bashGroup) throw new Error('bash group not found');
    expect(bashGroup.span_count).toBe(2);
    expect(bashGroup.totals['wall_ms']).toBe(7000);
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
    expect(bashGroup.pct_of_total['wall_ms']).toBeGreaterThan(0);
    expect(bashGroup.pct_of_total['wall_ms']).toBeLessThanOrEqual(100);
  });

  it('flags groups exceeding 40% for investigation', () => {
    const state = buildTestProfile();
    const result = profileSummary(state.builder.profile, { group_by: 'kind' });
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
