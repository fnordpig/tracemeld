// src/importers/import.test.ts
import { describe, it, expect } from 'vitest';
import { importProfile } from './import.js';
import { ProfileBuilder } from '../model/profile.js';

describe('importProfile', () => {
  it('auto-detects and imports collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importProfile(content, 'test.txt');
    expect(result.format_detected).toBe('collapsed');
    expect(result.samples_added).toBe(2);
    expect(result.frames_added).toBe(4);
    expect(result.lanes_added).toBe(1);
  });

  it('auto-detects and imports chrome trace', () => {
    const events = [
      { ph: 'X', name: 'doWork', ts: 0, dur: 5000, pid: 1, tid: 1, args: {} },
    ];
    const content = JSON.stringify({ traceEvents: events });
    const result = importProfile(content, 'trace.json');
    expect(result.format_detected).toBe('chrome_trace');
    expect(result.spans_added).toBe(1);
  });

  it('respects format hint', () => {
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt', 'collapsed');
    expect(result.format_detected).toBe('collapsed');
  });

  it('throws on unknown format', () => {
    expect(() => importProfile('random garbage', 'test.txt')).toThrow('unknown');
  });

  it('merges into existing ProfileBuilder', () => {
    const builder = new ProfileBuilder('existing');
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt', 'auto', builder);
    expect(builder.profile.lanes.length).toBeGreaterThan(1);
    expect(result.lanes_added).toBe(1);
  });

  it('returns value_types from imported data', () => {
    const content = 'main;foo 10\n';
    const result = importProfile(content, 'test.txt');
    expect(result.value_types).toContain('weight');
  });
});
