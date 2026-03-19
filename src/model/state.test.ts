// src/model/state.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from './state.js';

describe('ProfilerState', () => {
  it('initializes with a default profile and main lane', () => {
    const state = new ProfilerState();
    expect(state.builder.profile.name).toBe('session');
    expect(state.builder.getLane('main')).toBeDefined();
  });

  it('generates unique span IDs', () => {
    const state = new ProfilerState();
    const id1 = state.nextSpanId();
    const id2 = state.nextSpanId();
    expect(id1).not.toBe(id2);
  });

  it('generates unique marker IDs', () => {
    const state = new ProfilerState();
    const id1 = state.nextMarkerId();
    const id2 = state.nextMarkerId();
    expect(id1).not.toBe(id2);
  });

  it('manages span stack per lane', () => {
    const state = new ProfilerState();
    state.pushSpan('main', 's1');
    state.pushSpan('main', 's2');
    expect(state.currentSpanId('main')).toBe('s2');
    expect(state.spanDepth('main')).toBe(2);

    expect(state.popSpan('main')).toBe('s2');
    expect(state.currentSpanId('main')).toBe('s1');
    expect(state.spanDepth('main')).toBe(1);
  });

  it('returns null for empty span stack', () => {
    const state = new ProfilerState();
    expect(state.currentSpanId('main')).toBeNull();
    expect(state.popSpan('main')).toBeNull();
    expect(state.spanDepth('main')).toBe(0);
  });

  it('invalidates pattern cache on mutation', () => {
    const state = new ProfilerState();
    state.patternCache = []; // simulate cached patterns
    expect(state.patternCache).not.toBeNull();
    state.invalidatePatternCache();
    expect(state.patternCache).toBeNull();
  });
});
