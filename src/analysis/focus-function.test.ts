// src/analysis/focus-function.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { focusFunction, type FocusFunctionResult, type FocusFunctionNotFound } from './focus-function.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  handleTrace(state, { action: 'begin', kind: 'session', name: 'test' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000, input_tokens: 100 } });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm lint' });
  handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000, input_tokens: 50 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

function isResult(r: FocusFunctionResult | FocusFunctionNotFound): r is FocusFunctionResult {
  return 'function_name' in r;
}

describe('focusFunction', () => {
  it('finds a function by exact name', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'bash:npm test' });
    expect(isResult(result)).toBe(true);
    if (!isResult(result)) return;
    expect(result.function_name).toBe('bash:npm test');
    expect(result.span_count).toBe(1);
  });

  it('finds a function by substring match', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'npm test' });
    expect(isResult(result)).toBe(true);
    if (!isResult(result)) return;
    expect(result.function_name).toBe('bash:npm test');
  });

  it('returns not-found with available frames', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'nonexistent_function' });
    expect(isResult(result)).toBe(false);
    if (isResult(result)) return;
    expect(result.error).toContain('nonexistent_function');
    expect(result.available_frames.length).toBeGreaterThan(0);
  });

  it('reports self and total cost', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'bash:npm test' });
    if (!isResult(result)) return;
    expect(result.self_cost['wall_ms']).toBe(5000);
    expect(result.total_cost['wall_ms']).toBe(5000);
  });

  it('finds callers (parent spans)', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'bash:npm test' });
    if (!isResult(result)) return;
    expect(result.callers.length).toBeGreaterThan(0);
    const callerNames = result.callers.map((c) => c.name);
    expect(callerNames).toContain('turn:1');
  });

  it('finds callees (child spans)', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'turn:1' });
    if (!isResult(result)) return;
    expect(result.callees.length).toBeGreaterThan(0);
    const calleeNames = result.callees.map((c) => c.name);
    expect(calleeNames).toContain('bash:npm test');
  });

  it('ranks callees by cost', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, {
      function_name: 'turn:1',
      dimension: 'wall_ms',
    });
    if (!isResult(result)) return;
    expect(result.callees.length).toBeGreaterThanOrEqual(2);
    // bash:npm test (5000ms) should rank above file_read (200ms)
    expect(result.callees[0].name).toBe('bash:npm test');
  });

  it('computes pct_of_function_time for callees', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, {
      function_name: 'turn:1',
      dimension: 'wall_ms',
    });
    if (!isResult(result)) return;
    for (const callee of result.callees) {
      expect(callee.pct_of_function_time).toBeGreaterThan(0);
      expect(callee.pct_of_function_time).toBeLessThanOrEqual(100);
    }
  });

  it('respects top_n limit', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, {
      function_name: 'turn:1',
      top_n: 1,
    });
    if (!isResult(result)) return;
    expect(result.callees.length).toBeLessThanOrEqual(1);
  });

  it('includes investigate breadcrumb', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'bash:npm test' });
    if (!isResult(result)) return;
    expect(result.investigate).toContain('hotpaths');
  });

  it('case-insensitive substring match', () => {
    const state = buildTestProfile();
    const result = focusFunction(state.builder.profile, { function_name: 'NPM TEST' });
    expect(isResult(result)).toBe(true);
    if (!isResult(result)) return;
    expect(result.function_name).toBe('bash:npm test');
  });
});
