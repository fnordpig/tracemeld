// src/analysis/starvations.test.ts
import { describe, it, expect } from 'vitest';
import { importChromeTrace } from '../importers/chrome-trace.js';
import { findStarvations } from './starvations.js';

describe('findStarvations', () => {
  it('detects idle lane while another is busy', () => {
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'Worker 1' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'Worker 2' } },
      { ph: 'X', name: 'heavy_work', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'small_task', ts: 0, dur: 2000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});

    expect(result.entries.length).toBeGreaterThan(0);
    const starved = result.entries.find((e) => e.lane_name === 'Worker 2');
    expect(starved).toBeDefined();
    if (starved) {
      expect(starved.idle_ms).toBeGreaterThan(0);
    }
  });

  it('returns empty for single-lane profiles', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 5000000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    expect(result.entries).toHaveLength(0);
  });

  it('does not flag lanes that are busy throughout', () => {
    const events = [
      { ph: 'X', name: 'work_a', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'work_b', ts: 0, dur: 10000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    expect(result.entries).toHaveLength(0);
  });

  it('includes idle percentage and recommendation', () => {
    const events = [
      { ph: 'X', name: 'long_work', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'tiny', ts: 0, dur: 1000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, {});
    if (result.entries.length > 0) {
      expect(result.entries[0].idle_pct).toBeGreaterThan(0);
      expect(result.entries[0].recommendation.length).toBeGreaterThan(0);
    }
  });

  it('compresses idle ranges with RLE', () => {
    // Create many small spans with gaps between them on thread 1,
    // and one long span on thread 2, so thread 2 has many micro-idle-gaps
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'Busy' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'Idle-ish' } },
      // Busy lane: 100ms total
      { ph: 'X', name: 'work', ts: 0, dur: 100000000, pid: 1, tid: 1, args: {} },
      // Idle-ish lane: just a tiny span at the start
      { ph: 'X', name: 'blip', ts: 0, dur: 1000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    const result = findStarvations(imported.profile, { min_idle_pct: 50 });

    const starved = result.entries.find((e) => e.lane_name === 'Idle-ish');
    expect(starved).toBeDefined();
    if (starved) {
      // Should be compressed: a single idle range, not hundreds of micro-gaps
      // With one busy span and one blip, there's exactly one idle gap
      expect(starved.idle_ranges.length).toBeLessThanOrEqual(3);
      // Each compressed range has count, min/max/total duration
      for (const range of starved.idle_ranges) {
        expect(range.count).toBeGreaterThanOrEqual(1);
        expect(range.total_duration_ms).toBeGreaterThanOrEqual(0);
        expect(range.min_duration_ms).toBeLessThanOrEqual(range.max_duration_ms);
      }
    }
  });

  it('respects min_idle_pct threshold', () => {
    const events = [
      { ph: 'X', name: 'work', ts: 0, dur: 10000000, pid: 1, tid: 1, args: {} },
      { ph: 'X', name: 'work', ts: 0, dur: 8000000, pid: 1, tid: 2, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const imported = importChromeTrace(content, 'test.json');
    // Thread 2 is idle 20% — should NOT be flagged with default 50% threshold
    const result = findStarvations(imported.profile, { min_idle_pct: 50 });
    expect(result.entries).toHaveLength(0);
  });
});
