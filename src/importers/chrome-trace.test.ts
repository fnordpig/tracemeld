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

  it('sets parent_id and children for nested B/E events', () => {
    // A contains B contains C
    const events = [
      { ph: 'B', name: 'A', ts: 1000, pid: 1, tid: 1 },
      { ph: 'B', name: 'B', ts: 2000, pid: 1, tid: 1 },
      { ph: 'B', name: 'C', ts: 3000, pid: 1, tid: 1 },
      { ph: 'E', name: 'C', ts: 4000, pid: 1, tid: 1 },
      { ph: 'E', name: 'B', ts: 5000, pid: 1, tid: 1 },
      { ph: 'E', name: 'A', ts: 6000, pid: 1, tid: 1 },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const spans = result.profile.lanes[0].spans;
    expect(spans).toHaveLength(3);

    const spanA = spans[0];
    const spanB = spans[1];
    const spanC = spans[2];

    // A is root
    expect(spanA.parent_id).toBeNull();
    // B is child of A
    expect(spanB.parent_id).toBe(spanA.id);
    // C is child of B
    expect(spanC.parent_id).toBe(spanB.id);

    // children arrays
    expect(spanA.children).toContain(spanB.id);
    expect(spanB.children).toContain(spanC.id);
    expect(spanC.children).toHaveLength(0);
  });

  it('sets parent_id and children for nested X (complete) events', () => {
    // outer contains inner
    const events = [
      { ph: 'X', name: 'outer', ts: 0, dur: 10000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'inner', ts: 2000, dur: 3000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const spans = result.profile.lanes[0].spans;
    expect(spans).toHaveLength(2);

    const outer = spans.find((s) => result.profile.frames[s.frame_index].name === 'outer')!;
    const inner = spans.find((s) => result.profile.frames[s.frame_index].name === 'inner')!;

    expect(outer.parent_id).toBeNull();
    expect(inner.parent_id).toBe(outer.id);
    expect(outer.children).toContain(inner.id);
    expect(inner.children).toHaveLength(0);
  });

  it('handles mixed B/E and X events with nesting', () => {
    const events = [
      { ph: 'B', name: 'outer', ts: 0, pid: 1, tid: 1 },
      { ph: 'X', name: 'inner_x', ts: 1000, dur: 2000, pid: 1, tid: 1, args: {} },
      { ph: 'E', name: 'outer', ts: 10000, pid: 1, tid: 1 },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const spans = result.profile.lanes[0].spans;
    expect(spans).toHaveLength(2);

    const outer = spans.find((s) => result.profile.frames[s.frame_index].name === 'outer')!;
    const innerX = spans.find((s) => result.profile.frames[s.frame_index].name === 'inner_x')!;

    // The X event should be nested under the B/E outer span via post-processing
    // Both start as parent_id null from initial creation, but outer is root and inner_x is contained
    // The X post-processing should detect inner_x is contained within outer
    expect(outer.parent_id).toBeNull();
    expect(innerX.parent_id).toBe(outer.id);
    expect(outer.children).toContain(innerX.id);
  });

  it('keeps parent_id null for sequential (non-nested) spans', () => {
    const events = [
      { ph: 'X', name: 'first', ts: 0, dur: 1000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'second', ts: 2000, dur: 1000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importChromeTrace(content, 'trace.json');
    const spans = result.profile.lanes[0].spans;
    expect(spans).toHaveLength(2);

    expect(spans[0].parent_id).toBeNull();
    expect(spans[1].parent_id).toBeNull();
    expect(spans[0].children).toHaveLength(0);
    expect(spans[1].children).toHaveLength(0);
  });
});
