// src/exporters/baseline-types.ts

import type { ValueType } from '../model/types.js';

// ── Baseline Digest ────────────────────────────────────────────────

export interface BaselineDigest {
  /** Format version for forward compatibility. */
  version: 1;

  /** tracemeld version that produced this baseline. */
  exporter: string;

  /** When the baseline was captured (unix timestamp ms). */
  created_at: number;

  /** Agent-supplied semantic tags. */
  tags: BaselineTags;

  /** Value type schema — what dimensions are measured. */
  value_types: ValueType[];

  /** Source format provenance chain. */
  source_formats: string[];

  /** Headline totals across all dimensions. */
  totals: Record<string, number>;

  /** Per-kind breakdown. */
  kind_breakdown: KindBreakdown[];

  /**
   * Per-frame aggregated cost — data for differential flamegraph computation.
   * Keyed by semicolon-joined frame ancestry (root;parent;child).
   */
  frame_costs: FrameCost[];

  /** Top N hotspots by each dimension. */
  hotspots: DimensionHotspots[];

  /** Detected anti-patterns at time of capture. */
  patterns: PatternEntry[];

  /** Summary statistics. */
  stats: BaselineStats;
}

export interface BaselineTags {
  /** What this checkpoint represents. */
  checkpoint: string;
  /** Human-readable description of the task or change. */
  task?: string;
  /** Git commit hash at time of capture. */
  commit?: string;
  /** Arbitrary key-value metadata. */
  [key: string]: unknown;
}

export interface KindBreakdown {
  kind: string;
  totals: Record<string, number>;
  span_count: number;
  error_count: number;
}

export interface FrameCost {
  stack: string;
  self_cost: number[];
  total_cost: number[];
  call_count: number;
}

export interface DimensionHotspots {
  dimension: string;
  entries: HotspotEntry[];
}

export interface HotspotEntry {
  name: string;
  self_cost: number;
  pct_of_total: number;
}

export interface PatternEntry {
  name: string;
  severity: string;
  description: string;
  count: number;
}

export interface BaselineStats {
  span_count: number;
  sample_count: number;
  frame_count: number;
  lane_count: number;
  error_count: number;
  wall_duration_ms: number;
}

// ── Diff Result ────────────────────────────────────────────────────

export interface DiffResult {
  baseline_name: string;
  baseline_created_at: number;
  normalized: boolean;
  norm_factor?: number;

  headline: Record<string, {
    before: number;
    after: number;
    delta: number;
    delta_pct: number;
  }>;

  regressions: DiffEntry[];
  improvements: DiffEntry[];
  new_stacks: DiffEntry[];
  removed_stacks: DiffEntry[];

  regression_warnings: { dimension: string; delta_pct: number; note: string }[];

  pattern_diff: {
    new_patterns: string[];
    resolved_patterns: string[];
  };
}

export interface DiffEntry {
  stack: string;
  name: string;
  before: Record<string, number>;
  after: Record<string, number>;
  delta: Record<string, number>;
  delta_pct: Record<string, number>;
  likely_refactoring?: boolean;
}
