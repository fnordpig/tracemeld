// src/patterns/redundant-read.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectRedundantRead } from './redundant-read.js';

describe('detectRedundantRead', () => {
  it('detects same file read twice in a turn with no write', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'thinking', name: 'analyzing' });
    handleTrace(state, { action: 'end', kind: 'thinking', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('redundant_read');
    expect(matches[0].counterfactual_savings['input_tokens']).toBe(3000);
  });

  it('does not flag reads separated by a write to the same file', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { output_tokens: 500 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag reads of different files', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/user.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 2000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectRedundantRead(state.builder.profile);
    expect(matches).toHaveLength(0);
  });
});
