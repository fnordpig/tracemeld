// src/instrument/mark.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleMark } from './mark.js';

describe('handleMark', () => {
  it('creates a marker with timestamp', () => {
    const state = new ProfilerState();
    const result = handleMark(state, { what: 'test failure' });
    expect(result.marker_id).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('records severity on the marker', () => {
    const state = new ProfilerState();
    handleMark(state, { what: 'tests failed', severity: 'error' });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('expected lane');
    const marker = lane.markers[0];
    expect(marker.severity).toBe('error');
  });

  it('defaults severity to info', () => {
    const state = new ProfilerState();
    handleMark(state, { what: 'checkpoint' });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('expected lane');
    const marker = lane.markers[0];
    expect(marker.severity).toBe('info');
  });

  it('attaches structured data', () => {
    const state = new ProfilerState();
    handleMark(state, {
      what: 'context pressure',
      data: { utilization: 0.78 },
    });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('expected lane');
    const marker = lane.markers[0];
    expect(marker.data).toEqual({ utilization: 0.78 });
  });
});
