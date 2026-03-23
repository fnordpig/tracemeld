// src/exporters/chrome-trace.test.ts
import { describe, it, expect } from 'vitest';
import { exportChromeTrace } from './chrome-trace.js';
import { ProfileBuilder } from '../model/profile.js';
import type { ValueType } from '../model/types.js';

function makeValueTypes(): ValueType[] {
  return [
    { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
    { key: 'tokens', unit: 'none', description: 'Token count' },
  ];
}

interface TraceEvent {
  ph: string;
  name: string;
  cat?: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  s?: string;
  args?: Record<string, unknown>;
}

function getEvents(result: object): TraceEvent[] {
  return (result as { traceEvents: TraceEvent[] }).traceEvents;
}

describe('exportChromeTrace', () => {
  describe('basic span → X event conversion', () => {
    it('converts spans to X events with correct ms→μs timestamps', () => {
      const builder = new ProfileBuilder('test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'llm:call' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 10,
        end_time: 60,
        values: [50, 100],
        args: {},
        children: [],
      });

      const result = exportChromeTrace(builder.profile);
      const events = getEvents(result);
      const xEvents = events.filter((e) => e.ph === 'X');

      expect(xEvents.length).toBe(1);
      const evt = xEvents[0];
      expect(evt.name).toBe('llm:call');
      // ms → μs: multiply by 1000
      expect(evt.ts).toBe(10000);
      expect(evt.dur).toBe(50000);
    });

    it('preserves sub-millisecond precision in timestamps', () => {
      const builder = new ProfileBuilder('precision-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'fast:op' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 1.234,
        end_time: 1.567,
        values: [0.333, 0],
        args: {},
        children: [],
      });

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      expect(xEvents[0].ts).toBe(1234);
      expect(xEvents[0].dur).toBeCloseTo(333, 5);
    });
  });

  describe('marker → i event conversion', () => {
    it('converts markers to i events with correct timestamps', () => {
      const builder = new ProfileBuilder('marker-test', makeValueTypes());

      builder.addMarker('main', {
        timestamp: 25.5,
        name: 'checkpoint',
        data: { step: 3 },
      });

      const result = exportChromeTrace(builder.profile);
      const iEvents = getEvents(result).filter((e) => e.ph === 'i');

      expect(iEvents.length).toBe(1);
      const evt = iEvents[0];
      expect(evt.name).toBe('checkpoint');
      expect(evt.ts).toBe(25500);
      expect(evt.s).toBe('t');
      expect(evt.args).toEqual({ step: 3 });
    });
  });

  describe('lane metadata → M events', () => {
    it('emits process_name and thread_name M events for each lane', () => {
      const builder = new ProfileBuilder('meta-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'op:a' });

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

      const result = exportChromeTrace(builder.profile);
      const mEvents = getEvents(result).filter((e) => e.ph === 'M');

      expect(mEvents.length).toBe(2);

      const processName = mEvents.find((e) => e.name === 'process_name');
      const threadName = mEvents.find((e) => e.name === 'thread_name');

      if (!processName || !threadName) throw new Error('expected M events');
      expect(processName.args).toEqual({ name: 'main' });
      expect(threadName.args).toEqual({ name: 'main' });
    });
  });

  describe('multi-lane profiles', () => {
    it('produces correct pid/tid assignments', () => {
      const builder = new ProfileBuilder('multi-lane', makeValueTypes());
      const workerLane = builder.addLane('worker', 'worker');

      const fi0 = builder.frameTable.getOrInsert({ name: 'op:a' });
      const fi1 = builder.frameTable.getOrInsert({ name: 'op:b' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi0,
        parent_id: null,
        start_time: 0,
        end_time: 50,
        values: [50, 10],
        args: {},
        children: [],
      });

      builder.addSpan(workerLane.id, {
        id: 's2',
        frame_index: fi1,
        parent_id: null,
        start_time: 5,
        end_time: 40,
        values: [35, 20],
        args: {},
        children: [],
      });

      const result = exportChromeTrace(builder.profile);
      const events = getEvents(result);
      const xEvents = events.filter((e) => e.ph === 'X');

      // Lane 0 (main) → pid=0, Lane 1 (worker) → pid=1 (no explicit pid/tid)
      expect(xEvents[0].pid).toBe(0);
      expect(xEvents[0].tid).toBe(0);
      expect(xEvents[1].pid).toBe(1);
      expect(xEvents[1].tid).toBe(0);
    });

    it('uses lane.pid and lane.tid when set', () => {
      const builder = new ProfileBuilder('pid-test', makeValueTypes());
      const lane = builder.addLane('custom-lane', 'worker');
      lane.pid = 42;
      lane.tid = 7;

      const fi = builder.frameTable.getOrInsert({ name: 'op:c' });
      builder.addSpan(lane.id, {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 0,
        end_time: 10,
        values: [10, 0],
        args: {},
        children: [],
      });

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      const workerEvents = xEvents.filter((e) => e.name === 'op:c');

      expect(workerEvents.length).toBe(1);
      expect(workerEvents[0].pid).toBe(42);
      expect(workerEvents[0].tid).toBe(7);
    });
  });

  describe('frame name and category mapping', () => {
    it('uses frame name as event name', () => {
      const builder = new ProfileBuilder('name-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'tool:file_read' });

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

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      expect(xEvents[0].name).toBe('tool:file_read');
    });

    it('uses category name from categories array when category_index is set', () => {
      const builder = new ProfileBuilder('cat-test', makeValueTypes());
      builder.profile.categories.push({ name: 'llm' });
      const fi = builder.frameTable.getOrInsert({
        name: 'llm:call',
        category_index: 0,
      });

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

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      expect(xEvents[0].cat).toBe('llm');
    });

    it('defaults category to "default" when no category_index', () => {
      const builder = new ProfileBuilder('nocat-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'op:a' });

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

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      expect(xEvents[0].cat).toBe('default');
    });
  });

  describe('include_idle filtering', () => {
    function buildIdleProfile() {
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

      return builder.profile;
    }

    it('excludes user_input: spans by default', () => {
      const profile = buildIdleProfile();
      const result = exportChromeTrace(profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');

      expect(xEvents.length).toBe(1);
      expect(xEvents[0].name).toBe('llm:call');
    });

    it('includes user_input: spans when include_idle is true', () => {
      const profile = buildIdleProfile();
      const result = exportChromeTrace(profile, { include_idle: true });
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');

      expect(xEvents.length).toBe(2);
      expect(xEvents.map((e) => e.name)).toContain('user_input:wait');
    });
  });

  describe('args/values pass-through', () => {
    it('passes span args and values into event args', () => {
      const builder = new ProfileBuilder('args-test', makeValueTypes());
      const fi = builder.frameTable.getOrInsert({ name: 'llm:call' });

      builder.addSpan('main', {
        id: 's1',
        frame_index: fi,
        parent_id: null,
        start_time: 0,
        end_time: 100,
        values: [100, 50],
        args: { model: 'gpt-4', temperature: 0.7 },
        children: [],
      });

      const result = exportChromeTrace(builder.profile);
      const xEvents = getEvents(result).filter((e) => e.ph === 'X');
      const args = xEvents[0].args ?? {};

      // Original args are preserved
      expect(args['model']).toBe('gpt-4');
      expect(args['temperature']).toBe(0.7);

      // Values are converted to a keyed record
      const values = args['values'] as Record<string, number>;
      expect(values['wall_ms']).toBe(100);
      expect(values['tokens']).toBe(50);
    });

    it('passes marker data into event args', () => {
      const builder = new ProfileBuilder('marker-args-test', makeValueTypes());

      builder.addMarker('main', {
        timestamp: 10,
        name: 'error',
        data: { message: 'timeout', code: 504 },
      });

      const result = exportChromeTrace(builder.profile);
      const iEvents = getEvents(result).filter((e) => e.ph === 'i');
      expect(iEvents[0].args).toEqual({ message: 'timeout', code: 504 });
    });
  });

  describe('edge cases', () => {
    it('handles empty profile with no spans or markers', () => {
      const builder = new ProfileBuilder('empty-test', makeValueTypes());
      const result = exportChromeTrace(builder.profile);
      const events = getEvents(result);

      // Only M events for the default main lane
      const nonMeta = events.filter((e) => e.ph !== 'M');
      expect(nonMeta.length).toBe(0);
    });

    it('output has traceEvents array at top level', () => {
      const builder = new ProfileBuilder('structure-test', makeValueTypes());
      const result = exportChromeTrace(builder.profile) as Record<string, unknown>;
      expect(Array.isArray(result['traceEvents'])).toBe(true);
    });
  });
});
