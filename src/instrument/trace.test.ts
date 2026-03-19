// src/instrument/trace.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from './trace.js';

describe('handleTrace', () => {
  it('begins a span and returns span_id and depth', () => {
    const state = new ProfilerState();
    const result = handleTrace(state, {
      action: 'begin',
      kind: 'bash',
      name: 'npm test',
    });
    expect(result.span_id).toBeDefined();
    expect(result.depth).toBe(1);
    expect(result.parent_id).toBeUndefined();
  });

  it('nests spans correctly', () => {
    const state = new ProfilerState();
    const r1 = handleTrace(state, { action: 'begin', kind: 'turn' });
    const r2 = handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    expect(r2.depth).toBe(2);
    expect(r2.parent_id).toBe(r1.span_id);
  });

  it('ends a span and returns elapsed_ms', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });

    const result = handleTrace(state, {
      action: 'end',
      kind: 'bash',
      cost: { wall_ms: 3400 },
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(result.depth).toBe(0);
  });

  it('creates frame as kind:name', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    const frame = state.builder.profile.frames[0];
    expect(frame).toBeDefined();
    expect(frame.name).toBe('bash:npm test');
  });

  it('defaults name to kind when name is omitted', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'thinking' });
    const frame = state.builder.profile.frames[0];
    expect(frame).toBeDefined();
    expect(frame.name).toBe('thinking');
  });

  it('merges cost into span values on end', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, {
      action: 'end',
      kind: 'bash',
      cost: { wall_ms: 5000, input_tokens: 100 },
    });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('Expected main lane to exist');
    const span = lane.spans[0];
    expect(span).toBeDefined();
    expect(span.values[0]).toBe(5000); // wall_ms at index 0
    expect(span.values[1]).toBe(100);  // input_tokens at index 1
  });

  it('records error on span when provided on end', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'bash' });
    handleTrace(state, {
      action: 'end',
      kind: 'bash',
      error: 'exit code 1',
    });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('Expected main lane to exist');
    const span = lane.spans[0];
    expect(span).toBeDefined();
    expect(span.error).toBe('exit code 1');
  });

  it('auto-closes mismatched stack top with warning', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn' });
    handleTrace(state, { action: 'begin', kind: 'bash' });
    // End 'turn' while 'bash' is on top — should auto-close bash first
    handleTrace(state, { action: 'end', kind: 'turn' });

    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('Expected main lane to exist');
    const spans = lane.spans;
    expect(spans).toHaveLength(2);
    // bash span should have auto_closed metadata
    const bashSpan = spans.find((s) =>
      state.builder.profile.frames[s.frame_index]?.name === 'bash'
    );
    expect(bashSpan?.args['auto_closed']).toBe(true);
  });

  it('handles end with empty stack gracefully', () => {
    const state = new ProfilerState();
    const result = handleTrace(state, { action: 'end', kind: 'bash' });
    // Should not throw, returns a no-op result
    expect(result.span_id).toBe('');
    expect(result.depth).toBe(0);
  });

  it('attaches metadata to span args', () => {
    const state = new ProfilerState();
    handleTrace(state, {
      action: 'begin',
      kind: 'bash',
      metadata: { command: 'npm test' },
    });
    const lane = state.builder.getLane('main');
    if (!lane) throw new Error('Expected main lane to exist');
    const span = lane.spans[0];
    expect(span).toBeDefined();
    expect(span.args['command']).toBe('npm test');
  });
});
