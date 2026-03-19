// src/patterns/retry-loop.ts
import type { Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, valuesToRecord } from '../analysis/query.js';

export function detectRetryLoop(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Group spans by parent_id to find siblings
  const siblingGroups = new Map<string, Span[]>();
  for (const span of allSpans) {
    const parentKey = span.parent_id ?? '__root__';
    let group = siblingGroups.get(parentKey);
    if (!group) {
      group = [];
      siblingGroups.set(parentKey, group);
    }
    group.push(span);
  }

  for (const siblings of siblingGroups.values()) {
    siblings.sort((a, b) => a.start_time - b.start_time);

    let i = 0;
    while (i < siblings.length) {
      const run: Span[] = [siblings[i]];

      while (
        i + 1 < siblings.length &&
        siblings[i + 1].frame_index === run[0].frame_index
      ) {
        i++;
        run.push(siblings[i]);
      }

      // A retry loop: 2+ consecutive same-frame spans where at least one (except possibly last) has error
      if (run.length >= 2) {
        const hasError = run.slice(0, -1).some((s) => s.error);
        if (hasError) {
          const savings = new Array<number>(profile.value_types.length).fill(0);
          for (let j = 0; j < run.length - 1; j++) {
            for (let k = 0; k < savings.length; k++) {
              savings[k] += run[j].values[k] ?? 0;
            }
          }

          matches.push({
            pattern: {
              name: 'retry_loop',
              description: `${run.length} consecutive attempts of the same operation with intervening errors`,
              severity: run.length >= 3 ? 'warning' : 'info',
              evidence: {
                attempt_count: run.length,
                errors: run.filter((s) => s.error).map((s) => s.error),
              },
            },
            span_ids: run.map((s) => s.id),
            counterfactual_savings: valuesToRecord(profile, savings),
            recommendation:
              'Read the error carefully before retrying. Consider a different approach after the first failure.',
          });
        }
      }

      i++;
    }
  }

  return matches;
}
