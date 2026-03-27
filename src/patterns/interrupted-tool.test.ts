// src/patterns/interrupted-tool.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectInterruptedTool } from './interrupted-tool.js';

describe('detectInterruptedTool', () => {
  it('detects span with args.interrupted = true', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 }, metadata: { interrupted: true } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectInterruptedTool(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('interrupted_tool');
    expect(matches[0].span_ids).toHaveLength(1);
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(5000);
  });

  it('detects span with error containing "interrupted"', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/foo.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', error: 'Tool was interrupted by user', cost: { wall_ms: 200 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectInterruptedTool(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('interrupted_tool');
  });

  it('does not flag non-interrupted spans', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectInterruptedTool(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag session or turn spans even if interrupted', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'end', kind: 'turn', metadata: { interrupted: true } });

    const matches = detectInterruptedTool(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('detects multiple interrupted tools', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 3000 }, metadata: { interrupted: true } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/bar.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', error: 'Interrupted', cost: { wall_ms: 100 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectInterruptedTool(state.builder.profile);
    expect(matches).toHaveLength(2);
  });
});
