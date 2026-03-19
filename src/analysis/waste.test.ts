// src/analysis/waste.test.ts
import { describe, it, expect } from 'vitest';
import { ProfilerState } from '../model/state.js';
import { handleTrace } from '../instrument/trace.js';
import { findWaste } from './waste.js';
import { PatternRegistry } from '../patterns/registry.js';
import { detectRetryLoop } from '../patterns/retry-loop.js';
import { detectRedundantRead } from '../patterns/redundant-read.js';
import { detectBlindEdit } from '../patterns/blind-edit.js';

function buildRegistry(): PatternRegistry {
  const registry = new PatternRegistry();
  registry.register(detectRetryLoop);
  registry.register(detectRedundantRead);
  registry.register(detectBlindEdit);
  return registry;
}

describe('findWaste', () => {
  it('returns empty when no waste detected', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 100 } });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items).toHaveLength(0);
    expect(result.total_savings['wall_ms']).toBe(0);
  });

  it('detects retry loop waste', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items.length).toBeGreaterThan(0);
    const retryItem = result.items.find((i) => i.pattern === 'retry_loop');
    expect(retryItem).toBeDefined();
    expect(result.total_savings['wall_ms']).toBeGreaterThan(0);
  });

  it('detects redundant read waste', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/auth.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { input_tokens: 3000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    const readItem = result.items.find((i) => i.pattern === 'redundant_read');
    expect(readItem).toBeDefined();
  });

  it('sorts items by largest savings', () => {
    const state = new ProfilerState();
    const registry = buildRegistry();
    handleTrace(state, { action: 'begin', kind: 'turn', name: '1' });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', error: 'fail', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'bash', name: 'npm test' });
    handleTrace(state, { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/a.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 1000 } });
    handleTrace(state, { action: 'begin', kind: 'file_read', name: 'src/a.ts' });
    handleTrace(state, { action: 'end', kind: 'file_read', cost: { wall_ms: 200, input_tokens: 1000 } });
    handleTrace(state, { action: 'end', kind: 'turn' });

    const result = findWaste(state.builder.profile, registry, {});
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    const firstSavings = Math.max(...Object.values(result.items[0].counterfactual_savings));
    const secondSavings = Math.max(...Object.values(result.items[1].counterfactual_savings));
    expect(firstSavings).toBeGreaterThanOrEqual(secondSavings);
  });
});
