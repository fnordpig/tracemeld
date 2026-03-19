// src/patterns/blind-edit.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectBlindEdit } from './blind-edit.js';

describe('detectBlindEdit', () => {
  it('detects file_write with no preceding file_read for same file', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('blind_edit');
  });

  it('does not flag when file was read first', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('does not flag when file was read in previous turn', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });
    handleTrace(state, { action: 'begin', kind: 'turn', name: '2' });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('flags write to file not read (even if other files were read)', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/user.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 2000 } });
    handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_write', cost: { wall_ms: 500 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectBlindEdit(state.builder.profile);
    expect(matches).toHaveLength(1);
  });
});
