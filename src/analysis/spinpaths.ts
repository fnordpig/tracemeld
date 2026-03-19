// src/analysis/spinpaths.ts
import type { Profile } from '../model/types.js';
import { getAllSpans, buildSpanIndex, getSpanAncestry, computeSelfCost } from './query.js';

export interface SpinpathsInput {
  min_wall_ms?: number;
}

export interface SpinpathEntry {
  span_id: string;
  name: string;
  ancestry: string[];
  wall_ms: number;
  output_produced: Record<string, number>;
  efficiency_ratio: number;
  recommendation: string;
}

export interface SpinpathsResult {
  entries: SpinpathEntry[];
}

export function findSpinpaths(profile: Profile, input: SpinpathsInput): SpinpathsResult {
  const minWallMs = input.min_wall_ms ?? 5000;
  const allSpans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);

  const wallIdx = profile.value_types.findIndex((vt) => vt.key === 'wall_ms');
  const outputIndices = profile.value_types
    .map((vt, i) => ({ key: vt.key, idx: i }))
    .filter(({ key }) => key === 'output_tokens' || key === 'bytes_written' || key === 'bytes_read');

  const entries: SpinpathEntry[] = [];

  for (const span of allSpans) {
    const selfCost = computeSelfCost(profile, span, spanIndex);
    const wallMs = wallIdx >= 0 ? (selfCost[wallIdx] ?? 0) : 0;
    if (wallMs < minWallMs) continue;

    const outputProduced: Record<string, number> = {};
    let totalOutput = 0;
    for (const { key, idx } of outputIndices) {
      const val = selfCost[idx] ?? 0;
      outputProduced[key] = val;
      totalOutput += val;
    }

    const wallSeconds = wallMs / 1000;
    const efficiencyRatio = wallSeconds > 0 ? totalOutput / wallSeconds : 0;

    if (efficiencyRatio < 10) {
      const frameName = profile.frames[span.frame_index]?.name ?? '<unknown>';
      entries.push({
        span_id: span.id,
        name: frameName,
        ancestry: getSpanAncestry(profile, span, spanIndex),
        wall_ms: wallMs,
        output_produced: outputProduced,
        efficiency_ratio: Math.round(efficiencyRatio * 100) / 100,
        recommendation: generateSpinRecommendation(frameName, wallMs, totalOutput),
      });
    }
  }

  entries.sort((a, b) => b.wall_ms - a.wall_ms);
  return { entries };
}

function generateSpinRecommendation(name: string, wallMs: number, totalOutput: number): string {
  const seconds = Math.round(wallMs / 1000);
  if (totalOutput === 0) {
    return `${name} spent ${seconds}s with no measurable output. Consider whether this operation is necessary or can be replaced.`;
  }
  return `${name} spent ${seconds}s producing minimal output. Consider breaking into smaller steps or adding timeouts.`;
}
