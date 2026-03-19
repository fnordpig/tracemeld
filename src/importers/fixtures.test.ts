// src/importers/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importProfile } from './import.js';
import { importCollapsed } from './collapsed.js';
import { importChromeTrace } from './chrome-trace.js';
import { importGecko } from './gecko.js';
import { importPprof } from './pprof.js';

describe('fixture-based importer tests', () => {
  describe('collapsed stacks (speedscope simple.txt)', () => {
    const content = readFileSync('fixtures/collapsed/simple.txt', 'utf-8');

    it('auto-detects as collapsed', () => {
      const result = importProfile(content, 'simple.txt');
      expect(result.format_detected).toBe('collapsed');
    });

    it('produces correct sample count', () => {
      const result = importCollapsed(content, 'simple.txt');
      // 5 non-empty lines = 5 samples
      expect(result.profile.lanes[0].samples).toHaveLength(5);
    });

    it('deduplicates frames correctly', () => {
      const result = importCollapsed(content, 'simple.txt');
      // Unique frames: a, b, c, d = 4
      expect(result.profile.frames).toHaveLength(4);
    });

    it('computes correct weights', () => {
      const result = importCollapsed(content, 'simple.txt');
      const totalWeight = result.profile.lanes[0].samples.reduce(
        (sum, s) => sum + (s.values[0] ?? 0),
        0,
      );
      // 1 + 1 + 4 + 3 + 5 = 14
      expect(totalWeight).toBe(14);
    });
  });

  describe('chrome trace events (speedscope simple.json)', () => {
    const content = readFileSync('fixtures/chrome-trace/simple.json', 'utf-8');

    it('auto-detects as chrome_trace', () => {
      const result = importProfile(content, 'simple.json');
      expect(result.format_detected).toBe('chrome_trace');
    });

    it('produces spans from B/E and X events', () => {
      const result = importChromeTrace(content, 'simple.json');
      const lane = result.profile.lanes[0];
      // alpha (B/E), beta (B/E), gamma (X), epsilon (X) = 4 spans
      expect(lane.spans).toHaveLength(4);
    });

    it('resolves frame names correctly', () => {
      const result = importChromeTrace(content, 'simple.json');
      const names = result.profile.frames.map((f) => f.name);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
      expect(names).toContain('epsilon');
    });

    it('preserves args from X events', () => {
      const result = importChromeTrace(content, 'simple.json');
      const gammaSpan = result.profile.lanes[0].spans.find(
        (s) => result.profile.frames[s.frame_index].name === 'gamma',
      );
      expect(gammaSpan?.args['detail']).toBe('foobar');
    });
  });

  describe('gecko profile (tracemeld simple.json)', () => {
    const content = readFileSync('fixtures/gecko/simple.json', 'utf-8');

    it('auto-detects as gecko', () => {
      const result = importProfile(content, 'simple.json');
      expect(result.format_detected).toBe('gecko');
    });

    it('produces correct sample count', () => {
      const result = importGecko(content, 'simple.json');
      expect(result.profile.lanes[0].samples).toHaveLength(4);
    });

    it('resolves all function names', () => {
      const result = importGecko(content, 'simple.json');
      const names = result.profile.frames.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['main', 'doWork', 'compute', 'render']));
    });
  });

  describe('pprof (speedscope simple.prof)', () => {
    it('imports with format hint', () => {
      const content = readFileSync('fixtures/pprof/simple.prof', 'binary');
      const result = importPprof(content, 'simple.prof');
      expect(result.format).toBe('pprof');
      expect(result.profile.lanes[0].samples.length).toBeGreaterThan(0);
    });

    it('extracts function names from string table', () => {
      const content = readFileSync('fixtures/pprof/simple.prof', 'binary');
      const result = importPprof(content, 'simple.prof');
      expect(result.profile.frames.length).toBeGreaterThan(0);
      // At least some frames should have non-empty names
      const namedFrames = result.profile.frames.filter(
        (f) => f.name.length > 0 && !f.name.startsWith('<'),
      );
      expect(namedFrames.length).toBeGreaterThan(0);
    });

    it('extracts value types', () => {
      const content = readFileSync('fixtures/pprof/simple.prof', 'binary');
      const result = importPprof(content, 'simple.prof');
      expect(result.profile.value_types.length).toBeGreaterThan(0);
    });
  });
});
