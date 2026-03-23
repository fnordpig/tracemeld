// src/importers/detect.test.ts
import { describe, it, expect } from 'vitest';
import { detectFormat } from './detect.js';

describe('detectFormat', () => {
  it('detects collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    expect(detectFormat(content)).toBe('collapsed');
  });

  it('detects chrome trace with traceEvents wrapper', () => {
    const content = JSON.stringify({ traceEvents: [{ ph: 'X', name: 'test', ts: 0, dur: 100 }] });
    expect(detectFormat(content)).toBe('chrome_trace');
  });

  it('detects chrome trace as raw array', () => {
    const content = JSON.stringify([{ ph: 'X', name: 'test', ts: 0, dur: 100 }]);
    expect(detectFormat(content)).toBe('chrome_trace');
  });

  it('detects gecko profile', () => {
    const content = JSON.stringify({ meta: { version: 24 }, threads: [], libs: [] });
    expect(detectFormat(content)).toBe('gecko');
  });

  it('detects speedscope format', () => {
    const content = JSON.stringify({ '$schema': 'https://www.speedscope.app/file-format-schema.json', shared: {}, profiles: [] });
    expect(detectFormat(content)).toBe('speedscope');
  });

  it('detects V8 CPUProfile format', () => {
    const content = JSON.stringify({
      nodes: [{ id: 1, callFrame: { functionName: '(root)' }, hitCount: 0 }],
      startTime: 0,
      endTime: 1000,
      samples: [1],
      timeDeltas: [1000],
    });
    expect(detectFormat(content)).toBe('v8_cpuprofile');
  });

  it('returns unknown for unrecognized content', () => {
    expect(detectFormat('just some random text')).toBe('unknown');
  });

  it('returns unknown for empty content', () => {
    expect(detectFormat('')).toBe('unknown');
  });
});
