// src/patterns/agent-sprawl.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { detectAgentSprawl } from './agent-sprawl.js';

describe('detectAgentSprawl', () => {
  it('detects 6 Agent subagent launches', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });

    for (let i = 0; i < 6; i++) {
      handleTrace(state, { action: 'begin', kind: 'Agent', name: `task-${i}` });
      handleTrace(state, { action: 'end', kind: 'Agent', cost: { wall_ms: 10000 } });
    }

    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectAgentSprawl(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.name).toBe('agent_sprawl');
    expect(matches[0].pattern.severity).toBe('info');
    expect(matches[0].span_ids).toHaveLength(6);
    expect(matches[0].pattern.evidence.agent_count).toBe(6);
  });

  it('does not flag fewer than 5 agents', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });

    for (let i = 0; i < 4; i++) {
      handleTrace(state, { action: 'begin', kind: 'Agent', name: `task-${i}` });
      handleTrace(state, { action: 'end', kind: 'Agent', cost: { wall_ms: 5000 } });
    }

    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectAgentSprawl(state.builder.profile);
    expect(matches).toHaveLength(0);
  });

  it('escalates to warning severity at 10+ agents', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });

    for (let i = 0; i < 10; i++) {
      handleTrace(state, { action: 'begin', kind: 'Agent', name: `task-${i}` });
      handleTrace(state, { action: 'end', kind: 'Agent', cost: { wall_ms: 8000 } });
    }

    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectAgentSprawl(state.builder.profile);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern.severity).toBe('warning');
    expect(matches[0].span_ids).toHaveLength(10);
  });

  it('computes counterfactual savings from bottom half', () => {
    const state = new ProfilerState();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });

    // 6 agents: sorted by wall_ms, bottom half (3) would be savings
    for (let i = 0; i < 6; i++) {
      handleTrace(state, { action: 'begin', kind: 'Agent', name: `task-${i}` });
      handleTrace(state, { action: 'end', kind: 'Agent', cost: { wall_ms: (i + 1) * 1000 } });
    }

    handleTrace(state, { action: 'end', kind: 'turn' });

    const matches = detectAgentSprawl(state.builder.profile);
    expect(matches).toHaveLength(1);
    // Bottom 3 agents: 1000 + 2000 + 3000 = 6000
    expect(matches[0].counterfactual_savings['wall_ms']).toBe(6000);
  });
});
