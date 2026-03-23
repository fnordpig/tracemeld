// src/importers/v8-cpuprofile.test.ts
import { describe, it, expect } from 'vitest';
import { importV8CpuProfile } from './v8-cpuprofile.js';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2] },
      { id: 2, callFrame: { functionName: 'main', scriptId: '1', url: 'file:///app.js', lineNumber: 0, columnNumber: 0 }, hitCount: 0, children: [3] },
      { id: 3, callFrame: { functionName: 'doWork', scriptId: '1', url: 'file:///app.js', lineNumber: 10, columnNumber: 4 }, hitCount: 3, children: [] },
    ],
    startTime: 0,
    endTime: 3000, // 3ms in microseconds
    samples: [3, 3, 3],
    timeDeltas: [1000, 1000, 1000], // 1ms between each sample
    ...overrides,
  });
}

describe('importV8CpuProfile', () => {
  it('imports a basic V8 CPUProfile', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    expect(result.format).toBe('v8_cpuprofile');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].samples).toHaveLength(3);
    expect(result.profile.value_types[0].key).toBe('cpu_ms');
  });

  it('reconstructs stacks root-first', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const sample = result.profile.lanes[0].samples[0];
    // Stack should be: (root) -> main -> doWork
    expect(sample.stack).toHaveLength(3);
    const frames = result.profile.frames;
    expect(frames[sample.stack[0]].name).toBe('(root)');
    expect(frames[sample.stack[1]].name).toBe('main');
    expect(frames[sample.stack[2]].name).toBe('doWork');
  });

  it('converts V8 0-based line/col to 1-based', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const doWork = result.profile.frames.find((f) => f.name === 'doWork');
    expect(doWork?.line).toBe(11); // 10 → 11
    expect(doWork?.col).toBe(5); // 4 → 5
  });

  it('skips line/col for synthetic frames (lineNumber -1)', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const root = result.profile.frames.find((f) => f.name === '(root)');
    expect(root?.line).toBeUndefined();
    expect(root?.col).toBeUndefined();
  });

  it('assigns sample weights from timeDeltas', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const samples = result.profile.lanes[0].samples;
    // Each delta is 1000us = 1ms
    for (const s of samples) {
      expect(s.values[0]).toBe(1);
    }
  });

  it('computes cumulative timestamps', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const samples = result.profile.lanes[0].samples;
    // startTime=0, deltas=[1000, 1000, 1000] → timestamps at 1ms, 2ms, 3ms
    expect(samples[0].timestamp).toBe(1);
    expect(samples[1].timestamp).toBe(2);
    expect(samples[2].timestamp).toBe(3);
  });

  it('preserves file URLs', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    const main = result.profile.frames.find((f) => f.name === 'main');
    expect(main?.file).toBe('file:///app.js');
  });

  it('handles anonymous functions', () => {
    const profile = JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2] },
        { id: 2, callFrame: { functionName: '', scriptId: '1', url: 'file:///x.js', lineNumber: 5, columnNumber: 0 }, hitCount: 1, children: [] },
      ],
      startTime: 0,
      endTime: 1000,
      samples: [2],
      timeDeltas: [1000],
    });
    const result = importV8CpuProfile(profile, 'test.cpuprofile');
    const anon = result.profile.frames.find((f) => f.name === '(anonymous)');
    expect(anon).toBeDefined();
  });

  it('throws on invalid input', () => {
    expect(() => importV8CpuProfile('{}', 'bad')).toThrow('missing nodes or samples');
  });

  it('records metadata', () => {
    const result = importV8CpuProfile(makeProfile(), 'test.cpuprofile');
    expect(result.profile.metadata['source_format']).toBe('v8_cpuprofile');
    expect(result.profile.metadata['sample_count']).toBe(3);
    expect(result.profile.metadata['duration_ms']).toBe(3);
  });
});
