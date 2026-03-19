// src/analysis/query.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import {
  getSpanById,
  getSpanAncestry,
  computeSelfCost,
  extractKind,
  filterSpansByTimeRange,
  getAllSpans,
} from './query.js';

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
  handleTrace(state, { action: 'begin', kind: 'thinking', name: 'planning' });
  handleTrace(state, { action: 'end', kind: 'thinking', cost: { wall_ms: 1000, input_tokens: 500 } });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('getAllSpans', () => {
  it('collects spans from all lanes', () => {
    const state = buildTestProfile();
    const spans = getAllSpans(state.builder.profile);
    expect(spans.length).toBe(6);
  });
});

describe('getSpanById', () => {
  it('finds a span by id', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const first = allSpans[0];
    const found = getSpanById(state.builder.profile, first.id);
    expect(found).toBe(first);
  });

  it('returns undefined for unknown id', () => {
    const state = buildTestProfile();
    expect(getSpanById(state.builder.profile, 'nonexistent')).toBeUndefined();
  });
});

describe('getSpanAncestry', () => {
  it('returns frame names from root to span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const bashSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'bash:npm test'
    );
    if (!bashSpan) throw new Error('bash span not found');
    const ancestry = getSpanAncestry(profile, bashSpan);
    expect(ancestry).toEqual(['session:test', 'turn:1', 'bash:npm test']);
  });

  it('returns single element for root span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const sessionSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'session:test'
    );
    if (!sessionSpan) throw new Error('session span not found');
    const ancestry = getSpanAncestry(profile, sessionSpan);
    expect(ancestry).toEqual(['session:test']);
  });
});

describe('computeSelfCost', () => {
  it('clamps self cost to zero when parent has no explicit cost', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');
    const selfCost = computeSelfCost(profile, turnSpan);
    expect(selfCost[0]).toBe(0);
    expect(selfCost[1]).toBe(0);
  });

  it('returns values directly for leaf span', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const bashSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'bash:npm test'
    );
    if (!bashSpan) throw new Error('bash span not found');
    const selfCost = computeSelfCost(profile, bashSpan);
    expect(selfCost).toEqual(bashSpan.values);
  });
});

describe('extractKind', () => {
  it('extracts kind from kind:detail format', () => {
    expect(extractKind('bash:npm test')).toBe('bash');
  });

  it('returns the full name when no colon', () => {
    expect(extractKind('thinking')).toBe('thinking');
  });
});

describe('filterSpansByTimeRange', () => {
  it('filters spans within time range', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const min = Math.min(...allSpans.map((s) => s.start_time));
    const max = Math.max(...allSpans.map((s) => s.end_time));
    const mid = Math.floor((min + max) / 2);
    const filtered = filterSpansByTimeRange(allSpans, { start_ms: mid, end_ms: max });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(allSpans.length);
  });

  it('returns all spans when no range given', () => {
    const state = buildTestProfile();
    const allSpans = getAllSpans(state.builder.profile);
    const filtered = filterSpansByTimeRange(allSpans, undefined);
    expect(filtered.length).toBe(allSpans.length);
  });
});
