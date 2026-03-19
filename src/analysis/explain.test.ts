// src/analysis/explain.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { handleMark } from '../instrument/mark.js';
import { explainSpan } from './explain.js';
import { getAllSpans } from './query.js';

function buildTestProfile(): ProfilerState {
  const state = new ProfilerState();
  handleTrace(state, { action: 'begin', kind: 'session', name: 'refactor' });
  handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
  handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
  handleTrace(state, {
    action: 'end',
    kind: 'file_read',
    cost: { wall_ms: 200, input_tokens: 3000 },
  });
  handleMark(state, { what: 'found auth issue', severity: 'info' });
  handleTrace(state, { action: 'begin', kind: 'file_write', name: 'src/auth.ts' });
  handleTrace(state, {
    action: 'end',
    kind: 'file_write',
    cost: { wall_ms: 500, output_tokens: 800 },
  });
  handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
  handleTrace(state, {
    action: 'end',
    kind: 'bash',
    cost: { wall_ms: 5000 },
    error: 'exit code 1',
  });
  handleTrace(state, { action: 'end', kind: 'turn' });
  handleTrace(state, { action: 'end', kind: 'session' });
  return state;
}

describe('explainSpan', () => {
  it('returns span details', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.span.name).toBe('turn:1');
    expect(result.span.kind).toBe('turn');
    expect(result.span.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns ancestry chain', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.ancestry).toEqual(['session:refactor', 'turn:1']);
  });

  it('returns children sorted by cost', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.children.length).toBe(3);
    // First child should be highest cost (bash: 5000 wall_ms)
    expect(result.children[0].name).toBe('bash:npm test');
  });

  it('includes pct_of_parent on children', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    for (const child of result.children) {
      expect(child.pct_of_parent['wall_ms']).toBeDefined();
    }
  });

  it('builds causal chain in chronological order', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    expect(result.causal_chain.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < result.causal_chain.length; i++) {
      expect(result.causal_chain[i].timestamp).toBeGreaterThanOrEqual(
        result.causal_chain[i - 1].timestamp,
      );
    }
  });

  it('includes markers in causal chain', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    const markerEvent = result.causal_chain.find((e) => e.kind === 'marker');
    expect(markerEvent).toBeDefined();
    if (!markerEvent) throw new Error('marker event not found');
    expect(markerEvent.event).toContain('found auth issue');
  });

  it('flags children with errors', () => {
    const state = buildTestProfile();
    const profile = state.builder.profile;
    const allSpans = getAllSpans(profile);
    const turnSpan = allSpans.find(
      (s) => profile.frames[s.frame_index].name === 'turn:1'
    );
    if (!turnSpan) throw new Error('turn span not found');

    const result = explainSpan(profile, { span_id: turnSpan.id });
    const bashChild = result.children.find((c) => c.name === 'bash:npm test');
    expect(bashChild?.error).toBe('exit code 1');
  });

  it('returns error for unknown span_id', () => {
    const state = buildTestProfile();
    const result = explainSpan(state.builder.profile, { span_id: 'nonexistent' });
    expect(result.span.name).toBe('<not found>');
  });
});
