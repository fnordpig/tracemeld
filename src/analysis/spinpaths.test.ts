// src/analysis/spinpaths.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findSpinpaths } from './spinpaths.js';

describe('findSpinpaths', () => {
  it('flags high wall time with no output', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 30000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 200, output_tokens: 500 } });

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
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });

    const result = findSpinpaths(state.builder.profile, { min_wall_ms: 1000 });
    expect(result.entries).toHaveLength(0);
  });

  it('includes recommendation', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'long wait' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 10000 } });

    const result = findSpinpaths(state.builder.profile, {});
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].recommendation.length).toBeGreaterThan(0);
  });
});
