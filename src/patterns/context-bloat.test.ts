// src/patterns/context-bloat.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectContextBloat } from './context-bloat.js';

/**
 * Helper: add cache_read_tokens value type to the profile builder,
 * since it's not part of the default LLM_VALUE_TYPES.
 */
function addCacheReadType(state: ProfilerState): number {
  return state.builder.addValueType({
    key: 'cache_read_tokens',
    unit: 'none',
    description: 'Cached context tokens read',
  });
}

/**
 * Helper: emit N turn spans with monotonically increasing cache_read_tokens.
 * Each turn gets `baseTokens + i * increment` cache_read_tokens.
 */
function emitTurns(
  state: ProfilerState,
  count: number,
  baseTokens: number,
  increment: number,
): void {
  for (let i = 0; i < count; i++) {
    handleTrace(state, { action: 'begin', kind: 'turn', name: `${i + 1}` });
    handleTrace(state, {
      action: 'end',
      kind: 'turn',
      cost: { cache_read_tokens: baseTokens + i * increment, wall_ms: 1000 },
    });
  }
}

describe('detectContextBloat', () => {
  it('detects monotonically increasing cache_read_tokens across 10 turns', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // 10 turns: 5000, 8000, 11000, ... 32000 (increment 3000, total growth 27000)
    emitTurns(state, 10, 5000, 3000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('context_bloat');
    expect(matches[0].pattern.evidence['run_length']).toBe(10);
    expect(matches[0].pattern.evidence['start_tokens']).toBe(5000);
    expect(matches[0].pattern.evidence['end_tokens']).toBe(32000);
    expect(matches[0].pattern.evidence['growth_tokens']).toBe(27000);
    expect(matches[0].span_ids).toHaveLength(10);
  });

  it('computes reasonable counterfactual savings', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    emitTurns(state, 10, 5000, 3000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(1);

    const savings = matches[0].counterfactual_savings;
    // Savings should be positive for cache_read_tokens
    expect(savings['cache_read_tokens']).toBeGreaterThan(0);
    // Cost savings should be present and positive
    expect(savings['cost_usd']).toBeGreaterThan(0);
  });

  it('does not detect runs shorter than 5 turns', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // Only 4 turns with increasing tokens
    emitTurns(state, 4, 5000, 5000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not detect flat cache_read_tokens (no growth)', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // 10 turns all with the same value -> not monotonically increasing (curr <= prev breaks the run)
    emitTurns(state, 10, 20000, 0);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not detect growth under 10K tokens', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // 6 turns: 1000, 2000, 3000, 4000, 5000, 6000 => growth = 5000 < 10000
    emitTurns(state, 6, 1000, 1000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('returns empty when cache_read_tokens value type is absent', () => {
    const state = new ProfilerState();
    // Don't add cache_read_tokens
    emitTurns(state, 10, 5000, 3000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('sets severity to warning when growth exceeds 100%', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // 6 turns: 5000, 10000, 15000, 20000, 25000, 30000 => growth = 500%
    emitTurns(state, 6, 5000, 5000);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.severity).toBe('warning');
  });

  it('sets severity to info when growth is under 100%', () => {
    const state = new ProfilerState();
    addCacheReadType(state);
    // 6 turns: 50000, 52500, 55000, 57500, 60000, 62500 => growth = 25%, > 10K
    emitTurns(state, 6, 50000, 2500);

    const matches = detectContextBloat(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.severity).toBe('info');
  });
});
