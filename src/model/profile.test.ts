// src/model/profile.test.ts
import { describe, it, expect } from 'vitest';
import { ProfileBuilder } from './profile.js';
import { LLM_VALUE_TYPES } from './types.js';

describe('ProfileBuilder', () => {
  it('creates a profile with default LLM value types', () => {
    const builder = new ProfileBuilder('test-session');
    const profile = builder.profile;
    expect(profile.name).toBe('test-session');
    expect(profile.value_types).toEqual(LLM_VALUE_TYPES);
    expect(profile.lanes).toHaveLength(1);
    expect(profile.lanes[0].id).toBe('main');
    expect(profile.lanes[0].kind).toBe('main');
  });

  it('creates a profile with custom value types', () => {
    const builder = new ProfileBuilder('custom', [
      { key: 'cpu_ns', unit: 'nanoseconds' },
    ]);
    expect(builder.profile.value_types).toHaveLength(1);
    expect(builder.profile.value_types[0].key).toBe('cpu_ns');
  });

  it('adds a lane', () => {
    const builder = new ProfileBuilder('test');
    const lane = builder.addLane('worker-1', 'worker');
    expect(lane.id).toBe('worker-1');
    expect(lane.kind).toBe('worker');
    expect(builder.profile.lanes).toHaveLength(2); // main + worker-1
  });

  it('gets a lane by id', () => {
    const builder = new ProfileBuilder('test');
    const lane = builder.getLane('main');
    expect(lane).toBeDefined();
    if (!lane) throw new Error('lane is undefined');
    expect(lane.name).toBe('main');
  });

  it('adds a span to a lane', () => {
    const builder = new ProfileBuilder('test');
    const frameIdx = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    const span = builder.addSpan('main', {
      id: 's1',
      frame_index: frameIdx,
      parent_id: null,
      start_time: 100,
      end_time: 200,
      values: [100, 0, 0, 0, 0, 0],
      args: {},
      children: [],
    });
    expect(span.id).toBe('s1');
    const mainLane = builder.getLane('main');
    expect(mainLane?.spans).toHaveLength(1);
  });

  it('adds a marker to a lane', () => {
    const builder = new ProfileBuilder('test');
    builder.addMarker('main', {
      timestamp: 150,
      name: 'test failure',
      severity: 'error',
    });
    expect(builder.getLane('main')?.markers).toHaveLength(1);
  });

  it('adds a sample to a lane', () => {
    const builder = new ProfileBuilder('test');
    builder.frameTable.getOrInsert({ name: 'func_a' });
    builder.addSample('main', {
      timestamp: null,
      stack: [0],
      values: [1],
    });
    expect(builder.getLane('main')?.samples).toHaveLength(1);
  });

  it('deduplicates frames through the frame table', () => {
    const builder = new ProfileBuilder('test');
    const idx1 = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    const idx2 = builder.frameTable.getOrInsert({ name: 'bash:npm test' });
    expect(idx1).toBe(idx2);
    expect(builder.profile.frames).toHaveLength(1);
  });

  it('resolves value type index by key', () => {
    const builder = new ProfileBuilder('test');
    expect(builder.valueTypeIndex('wall_ms')).toBe(0);
    expect(builder.valueTypeIndex('input_tokens')).toBe(1);
    expect(builder.valueTypeIndex('nonexistent')).toBe(-1);
  });
});
