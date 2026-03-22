// src/exporters/baseline.test.ts
import { describe, it, expect } from 'vitest';
import { exportBaseline } from './baseline.js';
import { ProfileBuilder } from '../model/profile.js';
import type { ValueType } from '../model/types.js';
import type { BaselineDigest } from './baseline-types.js';
import { PatternRegistry } from '../patterns/registry.js';
import type { PatternMatch } from '../patterns/types.js';

function makeValueTypes(): ValueType[] {
  return [
    { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
    { key: 'tokens', unit: 'none', description: 'Token count' },
  ];
}

function makeTags() {
  return { checkpoint: 'baseline', task: 'test task' };
}

/** Build a simple profile with a parent span containing two children. */
function buildBasicProfile() {
  const builder = new ProfileBuilder('test-profile', makeValueTypes());
  const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call' });
  const fi1 = builder.frameTable.getOrInsert({ name: 'tool:read' });
  const fi2 = builder.frameTable.getOrInsert({ name: 'tool:write' });

  builder.addSpan('main', {
    id: 's1',
    frame_index: fi0,
    parent_id: null,
    start_time: 0,
    end_time: 200,
    values: [200, 100],
    args: {},
    children: ['s2', 's3'],
  });
  builder.addSpan('main', {
    id: 's2',
    frame_index: fi1,
    parent_id: 's1',
    start_time: 10,
    end_time: 80,
    values: [70, 30],
    args: {},
    children: [],
  });
  builder.addSpan('main', {
    id: 's3',
    frame_index: fi2,
    parent_id: 's1',
    start_time: 90,
    end_time: 190,
    values: [100, 50],
    args: {},
    children: [],
    error: 'write failed',
  });

  return builder.profile;
}

describe('exportBaseline', () => {
  it('populates all required fields for a basic profile', () => {
    const profile = buildBasicProfile();
    const digest = exportBaseline(profile, makeTags());

    expect(digest.version).toBe(1);
    expect(digest.exporter).toMatch(/^tracemeld@/);
    expect(typeof digest.created_at).toBe('number');
    expect(digest.tags.checkpoint).toBe('baseline');
    expect(digest.tags.task).toBe('test task');
    expect(digest.value_types).toEqual(makeValueTypes());
    expect(Array.isArray(digest.source_formats)).toBe(true);
    expect(typeof digest.totals).toBe('object');
    expect(Array.isArray(digest.kind_breakdown)).toBe(true);
    expect(Array.isArray(digest.frame_costs)).toBe(true);
    expect(Array.isArray(digest.hotspots)).toBe(true);
    expect(Array.isArray(digest.patterns)).toBe(true);
    expect(typeof digest.stats).toBe('object');
  });

  describe('totals', () => {
    it('computes headline totals using self-cost to avoid double counting', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      // Parent s1: self = [200-70-100, 100-30-50] = [30, 20]
      // Child s2: self = [70, 30]
      // Child s3: self = [100, 50]
      // Total self = [200, 100]
      expect(digest.totals['wall_ms']).toBe(200);
      expect(digest.totals['tokens']).toBe(100);
    });
  });

  describe('kind_breakdown', () => {
    it('groups spans by frame kind and aggregates correctly', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      expect(digest.kind_breakdown.length).toBe(2); // 'llm' and 'tool'

      const llmKind = digest.kind_breakdown.find((k) => k.kind === 'llm');
      const toolKind = digest.kind_breakdown.find((k) => k.kind === 'tool');

      expect(llmKind).toBeDefined();
      expect(toolKind).toBeDefined();

      // llm kind: 1 span (s1), self cost = [30, 20]
      expect(llmKind!.span_count).toBe(1);
      expect(llmKind!.totals['wall_ms']).toBe(30);
      expect(llmKind!.totals['tokens']).toBe(20);
      expect(llmKind!.error_count).toBe(0);

      // tool kind: 2 spans (s2, s3), self cost = [70+100, 30+50] = [170, 80]
      expect(toolKind!.span_count).toBe(2);
      expect(toolKind!.totals['wall_ms']).toBe(170);
      expect(toolKind!.totals['tokens']).toBe(80);
      expect(toolKind!.error_count).toBe(1); // s3 has error
    });
  });

  describe('frame_costs', () => {
    it('builds correct stack paths and cost aggregation', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      // Three unique stack paths:
      // "llm:call" (s1 root)
      // "llm:call;tool:read" (s2)
      // "llm:call;tool:write" (s3)
      expect(digest.frame_costs.length).toBe(3);

      const rootCost = digest.frame_costs.find((fc) => fc.stack === 'llm:call');
      expect(rootCost).toBeDefined();
      expect(rootCost!.call_count).toBe(1);
      // self_cost for root: [200-70-100, 100-30-50] = [30, 20]
      expect(rootCost!.self_cost[0]).toBe(30);
      expect(rootCost!.self_cost[1]).toBe(20);
      // total_cost for root: [200, 100]
      expect(rootCost!.total_cost[0]).toBe(200);
      expect(rootCost!.total_cost[1]).toBe(100);

      const readCost = digest.frame_costs.find((fc) => fc.stack === 'llm:call;tool:read');
      expect(readCost).toBeDefined();
      expect(readCost!.call_count).toBe(1);
      expect(readCost!.self_cost[0]).toBe(70);
      expect(readCost!.self_cost[1]).toBe(30);
      expect(readCost!.total_cost[0]).toBe(70);
      expect(readCost!.total_cost[1]).toBe(30);

      const writeCost = digest.frame_costs.find((fc) => fc.stack === 'llm:call;tool:write');
      expect(writeCost).toBeDefined();
      expect(writeCost!.call_count).toBe(1);
      expect(writeCost!.self_cost[0]).toBe(100);
      expect(writeCost!.self_cost[1]).toBe(50);
    });

    it('aggregates multiple spans with same stack path', () => {
      const builder = new ProfileBuilder('agg-test', makeValueTypes());
      const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call' });

      // Two root-level spans with same frame => same stack "llm:call"
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
      builder.addSpan('main', {
        id: 's2',
        frame_index: fi0,
        parent_id: null,
        start_time: 60,
        end_time: 100,
        values: [40, 20],
        args: {},
        children: [],
      });

      const digest = exportBaseline(builder.profile, makeTags());
      expect(digest.frame_costs.length).toBe(1);
      const cost = digest.frame_costs[0];
      expect(cost.stack).toBe('llm:call');
      expect(cost.call_count).toBe(2);
      expect(cost.self_cost[0]).toBe(90);
      expect(cost.self_cost[1]).toBe(30);
      expect(cost.total_cost[0]).toBe(90);
      expect(cost.total_cost[1]).toBe(30);
    });
  });

  describe('hotspots', () => {
    it('populates hotspots for each dimension', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      expect(digest.hotspots.length).toBe(2); // wall_ms and tokens
      expect(digest.hotspots[0].dimension).toBe('wall_ms');
      expect(digest.hotspots[1].dimension).toBe('tokens');

      // Each dimension should have entries
      for (const hs of digest.hotspots) {
        expect(hs.entries.length).toBeGreaterThan(0);
        for (const entry of hs.entries) {
          expect(typeof entry.name).toBe('string');
          expect(typeof entry.self_cost).toBe('number');
          expect(typeof entry.pct_of_total).toBe('number');
        }
      }
    });

    it('hotspot entries have reasonable pct_of_total values', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      for (const hs of digest.hotspots) {
        let totalPct = 0;
        for (const entry of hs.entries) {
          expect(entry.pct_of_total).toBeGreaterThanOrEqual(0);
          expect(entry.pct_of_total).toBeLessThanOrEqual(100);
          totalPct += entry.pct_of_total;
        }
        // Sum of percentages should not exceed 100 (may be less due to top-N)
        expect(totalPct).toBeLessThanOrEqual(100.01);
      }
    });
  });

  describe('stats', () => {
    it('reports accurate statistics', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());

      expect(digest.stats.span_count).toBe(3);
      expect(digest.stats.sample_count).toBe(0);
      expect(digest.stats.frame_count).toBe(3); // llm:call, tool:read, tool:write
      expect(digest.stats.lane_count).toBe(1);
      expect(digest.stats.error_count).toBe(1); // s3 has error
      expect(digest.stats.wall_duration_ms).toBe(200); // 0 to 200
    });

    it('includes sample count in stats', () => {
      const builder = new ProfileBuilder('sample-stats', makeValueTypes());
      const fi0 = builder.frameTable.getOrInsert({ name: 'llm:call' });

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
      builder.addSample('main', { timestamp: 10, stack: [fi0], values: [5, 1] });
      builder.addSample('main', { timestamp: 20, stack: [fi0], values: [3, 2] });

      const digest = exportBaseline(builder.profile, makeTags());
      expect(digest.stats.span_count).toBe(1);
      expect(digest.stats.sample_count).toBe(2);
    });
  });

  describe('patterns', () => {
    it('collects detected patterns when registry is provided', () => {
      const profile = buildBasicProfile();
      const registry = new PatternRegistry();
      registry.register((_p) => [
        {
          pattern: {
            name: 'test-pattern',
            description: 'A test pattern',
            severity: 'warning',
            evidence: {},
          },
          span_ids: ['s1'],
          counterfactual_savings: {},
          recommendation: 'fix it',
        },
        {
          pattern: {
            name: 'test-pattern',
            description: 'A test pattern',
            severity: 'warning',
            evidence: {},
          },
          span_ids: ['s2'],
          counterfactual_savings: {},
          recommendation: 'fix it too',
        },
      ]);

      const digest = exportBaseline(profile, makeTags(), registry);
      expect(digest.patterns.length).toBe(1);
      expect(digest.patterns[0].name).toBe('test-pattern');
      expect(digest.patterns[0].severity).toBe('warning');
      expect(digest.patterns[0].count).toBe(2);
    });

    it('produces empty patterns when no registry is provided', () => {
      const profile = buildBasicProfile();
      const digest = exportBaseline(profile, makeTags());
      expect(digest.patterns).toEqual([]);
    });
  });

  describe('empty profile', () => {
    it('produces valid but empty digest', () => {
      const builder = new ProfileBuilder('empty', makeValueTypes());
      const digest = exportBaseline(builder.profile, makeTags());

      expect(digest.version).toBe(1);
      expect(digest.exporter).toMatch(/^tracemeld@/);
      expect(digest.totals['wall_ms']).toBe(0);
      expect(digest.totals['tokens']).toBe(0);
      expect(digest.kind_breakdown).toEqual([]);
      expect(digest.frame_costs).toEqual([]);
      expect(digest.hotspots.length).toBe(2); // still has entries per dimension
      for (const hs of digest.hotspots) {
        expect(hs.entries).toEqual([]);
      }
      expect(digest.patterns).toEqual([]);
      expect(digest.stats.span_count).toBe(0);
      expect(digest.stats.sample_count).toBe(0);
      expect(digest.stats.error_count).toBe(0);
      expect(digest.stats.wall_duration_ms).toBe(0);
    });
  });

  describe('size constraint', () => {
    it('digest for 1000 spans should be under 50KB when JSON-stringified', () => {
      const vts: ValueType[] = [
        { key: 'wall_ms', unit: 'milliseconds' },
        { key: 'tokens', unit: 'none' },
      ];
      const builder = new ProfileBuilder('large-profile', vts);

      // Create a set of frames that will be reused
      const frameCount = 20;
      const frameIndices: number[] = [];
      for (let i = 0; i < frameCount; i++) {
        frameIndices.push(builder.frameTable.getOrInsert({ name: `kind${i % 5}:op${i}` }));
      }

      // Create 1000 spans with a mix of parent-child relationships
      let spanId = 0;
      for (let batch = 0; batch < 100; batch++) {
        const parentFi = frameIndices[batch % frameCount];
        const parentId = `s${spanId}`;
        const batchStart = batch * 1000;

        builder.addSpan('main', {
          id: parentId,
          frame_index: parentFi,
          parent_id: null,
          start_time: batchStart,
          end_time: batchStart + 900,
          values: [900, 100],
          args: {},
          children: Array.from({ length: 9 }, (_, i) => `s${spanId + 1 + i}`),
        });
        spanId++;

        for (let c = 0; c < 9; c++) {
          const childFi = frameIndices[(batch * 9 + c) % frameCount];
          builder.addSpan('main', {
            id: `s${spanId}`,
            frame_index: childFi,
            parent_id: parentId,
            start_time: batchStart + c * 100,
            end_time: batchStart + c * 100 + 90,
            values: [90, 10],
            args: {},
            children: [],
          });
          spanId++;
        }
      }

      const digest = exportBaseline(builder.profile, makeTags());
      const json = JSON.stringify(digest);
      const sizeKB = json.length / 1024;

      expect(digest.stats.span_count).toBe(1000);
      expect(sizeKB).toBeLessThan(50);
    });
  });

  describe('source_formats', () => {
    it('reads source_formats from profile metadata', () => {
      const builder = new ProfileBuilder('fmt-test', makeValueTypes());
      builder.profile.metadata['source_formats'] = ['pprof', 'collapsed'];
      const digest = exportBaseline(builder.profile, makeTags());
      expect(digest.source_formats).toEqual(['pprof', 'collapsed']);
    });

    it('falls back to imported_from metadata', () => {
      const builder = new ProfileBuilder('fmt-test2', makeValueTypes());
      builder.profile.metadata['imported_from'] = 'chrome-trace';
      const digest = exportBaseline(builder.profile, makeTags());
      expect(digest.source_formats).toEqual(['chrome-trace']);
    });

    it('returns empty array when no format metadata', () => {
      const builder = new ProfileBuilder('fmt-test3', makeValueTypes());
      const digest = exportBaseline(builder.profile, makeTags());
      expect(digest.source_formats).toEqual([]);
    });
  });
});
