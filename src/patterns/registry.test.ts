import { describe, it, expect } from 'vitest';
import { PatternRegistry } from './registry.js';
import type { PatternDetector } from './types.js';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';

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
