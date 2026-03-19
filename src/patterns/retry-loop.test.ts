// src/patterns/retry-loop.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectRetryLoop } from './retry-loop.js';

describe('detectRetryLoop', () => {
  it('detects consecutive sibling spans with same frame and error', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit code 1', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('retry_loop');
    expect(matches[0].span_ids).toHaveLength(2);
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(5000);
  });

  it('does not flag non-consecutive same-frame spans', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'exit code 1', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/foo.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 100 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag consecutive same-frame without error', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('detects triple retry', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail 1', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail 2', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRetryLoop(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].span_ids).toHaveLength(3);
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(6000);
  });
});
