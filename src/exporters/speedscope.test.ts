// src/exporters/speedscope.test.ts
import { describe, it, expect } from 'vitest';
import { exportSpeedscope } from './speedscope.js';
import { ProfileBuilder } from '../model/profile.js';
import type { ValueType } from '../model/types.js';

function makeValueTypes(): ValueType[] {
  return [
    { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
    { key: 'tokens', unit: 'none', description: 'Token count' },
  ];
}

function parseExport(json: string) {
  return JSON.parse(json) as Record<string, unknown>;
}

describe('exportSpeedscope', () => {
  it('produces valid top-level structure with $schema and exporter', () => {
    const builder = new ProfileBuilder('test-profile', makeValueTypes());
    const json = exportSpeedscope(builder.profile);
    const file = parseExport(json);

    expect(file.$schema).toBe('https://www.speedscope.app/file-format-schema.json');
    expect(file.exporter).toMatch(/^tracemeld@/);
    expect(file.name).toBe('test-profile');
    expect(file.activeProfileIndex).toBe(0);
    expect(file.shared).toBeDefined();
    expect(file.profiles).toBeDefined();
  });

  describe('spans only (evented profiles)', () => {
    it('generates EventedProfiles from spans', () => {
      const builder = new ProfileBuilder('evented-test', makeValueTypes());
      const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call', file: 'agent.ts', line: 10 });
      const fi1 = builder.frameTable.getOrInsert({ name: 'tool:read', file: 'tools.ts', line: 20, col: 5 });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 100,
        values: [100, 50],
        args: {},
        children: ['s2'],
      });
      builder.addSpan('main', {
        id: 's2',
        frame_index: fi1,
        parent_id: 's1',
        start_time: 10,
        end_time: 60,
        values: [50, 30],
        args: {},
        children: [],
      });

      const json = exportSpeedscope(builder.profile);
      const file = parseExport(json);
      const profiles = file.profiles as Array<Record<string, unknown>>;

      // 1 lane × 2 value_types = 2 evented profiles
      expect(profiles.length).toBe(2);

      const p0 = profiles[0];
      expect(p0.type).toBe('evented');
      expect(p0.name).toBe('main \u2014 Wall-clock duration');
      expect(p0.unit).toBe('milliseconds');
      expect(p0.startValue).toBe(0);
      expect(p0.endValue).toBe(100);

      const events = p0.events as Array<{ type: string; at: number; frame: number }>;
      // 2 spans × 2 events each = 4 events
      expect(events.length).toBe(4);
      // Events should be sorted by at
      for (let i = 1; i < events.length; i++) {
        expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
      }

      const p1 = profiles[1];
      expect(p1.type).toBe('evented');
      expect(p1.name).toBe('main \u2014 Token count');
      expect(p1.unit).toBe('none');
    });

    it('maps frames to shared.frames with file, line, col', () => {
      const builder = new ProfileBuilder('frame-test', makeValueTypes());
      builder.frameTable.getOrInsert({ name: 'fn:a', file: 'a.ts', line: 1, col: 5 });
      builder.frameTable.getOrInsert({ name: 'fn:b' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: 0,
        parent_id: null,
        start_time: 0,
        end_time: 10,
        values: [10, 0],
        args: {},
        children: [],
      });

      const file = parseExport(exportSpeedscope(builder.profile));
      const shared = file.shared as { frames: Array<Record<string, unknown>> };

      expect(shared.frames[0]).toEqual({ name: 'fn:a', file: 'a.ts', line: 1, col: 5 });
      expect(shared.frames[1]).toEqual({ name: 'fn:b' });
    });

    it('frame indices in events reference valid shared.frames entries', () => {
      const builder = new ProfileBuilder('ref-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'test:frame' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 0,
        end_time: 10,
        values: [10, 0],
        args: {},
        children: [],
      });

      const file = parseExport(exportSpeedscope(builder.profile));
      const shared = file.shared as { frames: Array<Record<string, unknown>> };
      const profiles = file.profiles as Array<{ events: Array<{ frame: number }> }>;

      for (const p of profiles) {
        for (const evt of p.events) {
          expect(evt.frame).toBeGreaterThanOrEqual(0);
          expect(evt.frame).toBeLessThan(shared.frames.length);
        }
      }
    });
  });

  describe('samples only (sampled profiles)', () => {
    it('generates SampledProfiles from samples', () => {
      const builder = new ProfileBuilder('sampled-test', makeValueTypes());
      const fi0 = builder.frameTable.getOrInsert({ name: 'main' });
      const fi1 = builder.frameTable.getOrInsert({ name: 'foo' });
      const fi2 = builder.frameTable.getOrInsert({ name: 'bar' });

      builder.addSample('main', {
        timestamp: 0,
        stack: [fi0, fi1, fi2],
        values: [10, 5],
      });
      builder.addSample('main', {
        timestamp: 100,
        stack: [fi0, fi1],
        values: [20, 8],
      });

      const json = exportSpeedscope(builder.profile);
      const file = parseExport(json);
      const profiles = file.profiles as Array<Record<string, unknown>>;

      // 1 lane × 2 value_types = 2 sampled profiles
      expect(profiles.length).toBe(2);

      const p0 = profiles[0];
      expect(p0.type).toBe('sampled');
      expect(p0.unit).toBe('milliseconds');
      expect(p0.startValue).toBe(0);
      expect(p0.endValue).toBe(100);

      const samples = p0.samples as number[][];
      const weights = p0.weights as number[];
      expect(samples.length).toBe(2);
      expect(weights.length).toBe(2);
      expect(samples[0]).toEqual([fi0, fi1, fi2]);
      expect(samples[1]).toEqual([fi0, fi1]);
      expect(weights[0]).toBe(10);
      expect(weights[1]).toBe(20);

      // Second profile uses second dimension
      const p1 = profiles[1];
      const weights1 = p1.weights as number[];
      expect(weights1[0]).toBe(5);
      expect(weights1[1]).toBe(8);
    });

    it('samples and weights arrays have equal length', () => {
      const builder = new ProfileBuilder('len-test', makeValueTypes());
      const fi0 = builder.frameTable.getOrInsert({ name: 'root' });

      builder.addSample('main', { timestamp: 0, stack: [fi0], values: [1, 2] });
      builder.addSample('main', { timestamp: 10, stack: [fi0], values: [3, 4] });
      builder.addSample('main', { timestamp: 20, stack: [fi0], values: [5, 6] });

      const file = parseExport(exportSpeedscope(builder.profile));
      const profiles = file.profiles as Array<{ samples: number[][]; weights: number[] }>;

      for (const p of profiles) {
        expect(p.samples.length).toBe(p.weights.length);
      }
    });
  });

  describe('multi-lane, multi-value_type', () => {
    it('produces correct number of profiles for multiple lanes and value types', () => {
      const vts: ValueType[] = [
        { key: 'wall_ms', unit: 'milliseconds', description: 'Wall time' },
        { key: 'tokens', unit: 'none', description: 'Tokens' },
        { key: 'cost', unit: 'none', description: 'Cost' },
      ];
      const builder = new ProfileBuilder('multi-test', vts);
      const lane2 = builder.addLane('worker', 'worker');

      const fi0 = builder.frameTable.getOrInsert({ name: 'op:a' });
      const fi1 = builder.frameTable.getOrInsert({ name: 'op:b' });

      // Lane "main" has spans
      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 50,
        values: [50, 10, 1],
        args: {},
        children: [],
      });

      // Lane "worker" has samples
      builder.addSample(lane2.id, {
        timestamp: 0,
        stack: [fi1],
        values: [20, 5, 0.5],
      });

      const file = parseExport(exportSpeedscope(builder.profile));
      const profiles = file.profiles as Array<Record<string, unknown>>;

      // Lane "main": 1 lane × 3 value_types = 3 evented profiles
      // Lane "worker": 1 lane × 3 value_types = 3 sampled profiles
      expect(profiles.length).toBe(6);

      const evented = profiles.filter((p) => p.type === 'evented');
      const sampled = profiles.filter((p) => p.type === 'sampled');
      expect(evented.length).toBe(3);
      expect(sampled.length).toBe(3);
    });
  });

  describe('idle filtering', () => {
    it('excludes user_input: spans by default (includeIdle=false)', () => {
      const builder = new ProfileBuilder('idle-test', [
        { key: 'wall_ms', unit: 'milliseconds', description: 'Wall time' },
      ]);

      const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call' });
      const fi1 = builder.frameTable.getOrInsert({ name: 'user_input:wait' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 100,
        values: [100],
        args: {},
        children: [],
      });
      builder.addSpan('main', {
        id: 's2',
        frame_index: fi1,
        parent_id: null,
        start_time: 100,
        end_time: 500,
        values: [400],
        args: {},
        children: [],
      });

      // Default: includeIdle=false
      const file = parseExport(exportSpeedscope(builder.profile));
      const profiles = file.profiles as Array<{ events: Array<{ frame: number }> }>;
      const p0 = profiles[0];

      // Only 2 events (O+C for s1), s2 filtered out
      expect(p0.events.length).toBe(2);
      // All events should reference fi0, not fi1
      for (const evt of p0.events) {
        expect(evt.frame).toBe(fi0);
      }
    });

    it('includes user_input: spans when includeIdle=true', () => {
      const builder = new ProfileBuilder('idle-include-test', [
        { key: 'wall_ms', unit: 'milliseconds', description: 'Wall time' },
      ]);

      const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call' });
      const fi1 = builder.frameTable.getOrInsert({ name: 'user_input:wait' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 100,
        values: [100],
        args: {},
        children: [],
      });
      builder.addSpan('main', {
        id: 's2',
        frame_index: fi1,
        parent_id: null,
        start_time: 100,
        end_time: 500,
        values: [400],
        args: {},
        children: [],
      });

      const file = parseExport(exportSpeedscope(builder.profile, { includeIdle: true }));
      const profiles = file.profiles as Array<{ events: Array<{ frame: number }> }>;
      const p0 = profiles[0];

      // 4 events (O+C for each of the 2 spans)
      expect(p0.events.length).toBe(4);
    });
  });

  describe('edge cases', () => {
    it('handles empty profile (no lanes with data)', () => {
      const builder = new ProfileBuilder('empty-test', makeValueTypes());
      const file = parseExport(exportSpeedscope(builder.profile));
      const profiles = file.profiles as unknown[];
      expect(profiles.length).toBe(0);
    });

    it('handles lane with both spans and samples', () => {
      const builder = new ProfileBuilder('mixed-test', [
        { key: 'wall_ms', unit: 'milliseconds', description: 'Wall time' },
      ]);

      const fi0 = builder.frameTable.getOrInsert({ name: 'op:a' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 50,
        values: [50],
        args: {},
        children: [],
      });

      builder.addSample('main', {
        timestamp: 10,
        stack: [fi0],
        values: [5],
      });

      const file = parseExport(exportSpeedscope(builder.profile));
      const profiles = file.profiles as Array<Record<string, unknown>>;

      // 1 evented + 1 sampled for the single value_type
      expect(profiles.length).toBe(2);
      expect(profiles[0].type).toBe('evented');
      expect(profiles[1].type).toBe('sampled');
    });

    it('output parses as valid JSON', () => {
      const builder = new ProfileBuilder('json-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'test' });
      builder.addSpan('main', {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 0,
        end_time: 10,
        values: [10, 1],
        args: {},
        children: [],
      });

      const json = exportSpeedscope(builder.profile);
      expect(() => { JSON.parse(json); }).not.toThrow();
    });
  });
});
