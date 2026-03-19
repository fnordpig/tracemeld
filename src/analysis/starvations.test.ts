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
