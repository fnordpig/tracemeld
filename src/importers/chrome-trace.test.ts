// src/importers/chrome-trace.test.ts
import { describe, it, expect } from 'vitest';
import { importChromeTrace } from './chrome-trace.js';

describe('importChromeTrace', () => {
  it('imports X (complete) events as spans', () => {
    const events = [
      { ph: 'X', name: 'doWork', cat: 'function', ts: 1000, dur: 5000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'inner', cat: 'function', ts: 2000, dur: 1000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.format).toBe('chrome_trace');
    expect(result.profile.lanes.length).toBeGreaterThanOrEqual(1);
    expect(result.profile.lanes[0].spans).toHaveLength(2);
  });

  it('converts timestamps from microseconds to milliseconds', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 1000000, dur: 500000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const span = result.profile.lanes[0].spans[0];
    expect(span.start_time).toBe(1000);
    expect(span.end_time).toBe(1500);
  });

  it('imports B/E event pairs as spans', () => {
    const events = [
      { ph: 'B', name: 'task', ts: 1000, pid: 1, tid: 1 },
      { ph: 'E', name: 'task', ts: 5000, pid: 1, tid: 1 },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes[0].spans).toHaveLength(1);
    const span = result.profile.lanes[0].spans[0];
    expect(span.start_time).toBe(1);
    expect(span.end_time).toBe(5);
  });

  it('imports instant events as markers', () => {
    const events = [
      { ph: 'i', name: 'GC', ts: 3000, pid: 1, tid: 1, s: 't' },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes[0].markers).toHaveLength(1);
    expect(result.profile.lanes[0].markers[0].name).toBe('GC');
  });

  it('creates separate lanes for different pid+tid', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes).toHaveLength(2);
  });

  it('applies M (metadata) events to lane names', () => {
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'Main Thread' } },
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes[0].name).toBe('Main Thread');
  });

  it('handles raw array format (no traceEvents wrapper)', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify(events);
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes[0].spans).toHaveLength(1);
  });

  it('computes wall_ms values from duration', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 5000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.value_types[0].key).toBe('wall_ms');
    expect(result.profile.lanes[0].spans[0].values[0]).toBe(5);
  });

  it('preserves args on spans', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 100, pid: 1, tid: 1, args: { detail: 'test' } },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    expect(result.profile.lanes[0].spans[0].args['detail']).toBe('test');
  });
});
