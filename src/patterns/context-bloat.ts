// src/patterns/context-bloat.ts
import type { Frame, Profile } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, extractKind, valuesToRecord } from '../analysis/query.js';

export function detectContextBloat(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Find the value type index for cache_read_tokens
  const cacheReadIdx = profile.value_types.findIndex(vt => vt.key === 'cache_read_tokens');
  if (cacheReadIdx === -1) return matches;

  // Find turn spans sorted chronologically
  const turnSpans = allSpans
    .filter(s => {
      const name = (profile.frames[s.frame_index] as Frame | undefined)?.name ?? '';
      const kind = extractKind(name);
      return kind === 'turn' || kind === 'llm_turn'; // handle both old and new conventions
    })
    .sort((a, b) => a.start_time - b.start_time);

  if (turnSpans.length < 5) return matches; // need enough data points

  // Detect runs of monotonically increasing cache_read_tokens
  let runStart = 0;
  for (let i = 1; i <= turnSpans.length; i++) {
    const prev = turnSpans[i - 1].values[cacheReadIdx] ?? 0;
    const curr = i < turnSpans.length ? (turnSpans[i].values[cacheReadIdx] ?? 0) : -1;

    if (curr <= prev || i === turnSpans.length) {
      // Run ended
      const runLen = i - runStart;
      if (runLen >= 5) {
        const startTokens = turnSpans[runStart].values[cacheReadIdx] ?? 0;
        const endTokens = turnSpans[i - 1].values[cacheReadIdx] ?? 0;
        const growth = endTokens - startTokens;
        const growthPct = startTokens > 0 ? (growth / startTokens * 100) : 0;

        // Only flag if significant growth
        if (growth > 10000) {
          const runSpans = turnSpans.slice(runStart, i);

          // Counterfactual: if context had been pruned at the midpoint,
          // all subsequent turns would have saved ~50% of their cache reads
          const midIdx = Math.floor(runLen / 2);
          const midTokens = runSpans[midIdx].values[cacheReadIdx] ?? 0;
          const savings = new Array<number>(profile.value_types.length).fill(0);
          for (let j = midIdx + 1; j < runSpans.length; j++) {
            const excess = (runSpans[j].values[cacheReadIdx] ?? 0) - midTokens;
            if (excess > 0) savings[cacheReadIdx] += excess;
          }
          // Estimate cost savings
          const costIdx = profile.value_types.findIndex(vt => vt.key === 'cost_usd');
          if (costIdx !== -1) {
            savings[costIdx] = savings[cacheReadIdx] * 1.5 / 1_000_000; // $1.50/M cache read
          }

          matches.push({
            pattern: {
              name: 'context_bloat',
              description: `Cache read tokens grew continuously across ${runLen} turns: ${Math.round(startTokens / 1000)}k \u2192 ${Math.round(endTokens / 1000)}k (+${Math.round(growthPct)}%)`,
              severity: growthPct > 100 ? 'warning' : 'info',
              evidence: {
                run_length: runLen,
                start_tokens: startTokens,
                end_tokens: endTokens,
                growth_tokens: growth,
                growth_pct: Math.round(growthPct),
              },
            },
            span_ids: runSpans.map(s => s.id),
            counterfactual_savings: valuesToRecord(profile, savings),
            recommendation: 'Consider pruning context mid-session, starting a new session, or using reduce-session to compress the transcript.',
          });
        }
      }
      runStart = i;
    }
  }

  return matches;
}
